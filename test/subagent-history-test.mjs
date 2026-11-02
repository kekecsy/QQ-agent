import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-agent-test-'));
process.env.QQ_AGENT_DATA_DIR = dir;
try {
  const { ChatStore } = await import('../src/store.js');
  const store = new ChatStore();
  store.appendIncoming('group:1', { mid: 2, ts: 2000, text: 'live' });
  const history = [{ mid: 1, ts: 1000, text: 'old', self: false }, { mid: 2, ts: 2000, text: 'duplicate' }];
  assert.equal(store.importHistory('group:1', history), 1);
  assert.equal(store.importHistory('group:1', history), 0);
  assert.equal(store.unreadCount('group:1'), 1);
  assert.deepEqual(store.recent('group:1', { limit: 10 }).map((m) => m.mid), [1, 2]);
  assert.equal(store.findByMid('group:1', 1).read, true);
  assert.equal(new ChatStore().findByMid('group:1', 1).historical, true);

  const { updateConfig } = await import('../src/config.js');
  updateConfig({ subagent: { enabled: true, provider: 'worker', model: 'worker-model' },
    providers: [{ id: 'worker', baseURL: 'https://worker.example/v1', models: ['worker-model'] }],
    dshProviderKeys: { worker: 'test-key' } });
  const { buildToolDefs, executeTool, getImagePartsOrVideo } = await import('../src/tools.js');
  let body;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, options) => {
    body = JSON.parse(options.body);
    assert.equal(options.headers.authorization, 'Bearer test-key');
    return new Response(JSON.stringify({ choices: [{ message: { content: 'x'.repeat(2000) }, finish_reason: 'stop' }] }),
      { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  try {
    const result = await executeTool(buildToolDefs(), { chatKey: 'group:1', store }, 'delegate_analysis',
      { task: 'summarize', source: 'z'.repeat(30000) });
    assert.equal(result.isError, undefined, result.content);
    const payload = JSON.parse(result.content);
    assert.equal(payload.summary.length, 1800);
    assert.equal(payload.inputTruncated, true);
    assert.equal(body.messages.length, 2);
    assert.equal(body.model, 'worker-model');
    assert.equal(body.tools, undefined);
    assert.ok(body.messages[1].content.length < 21000);
    assert.equal(body.max_tokens, 1024);
    updateConfig({ subagent: { mode: 'memes', visionProvider: 'vision', visionModel: 'vision-model' },
      providers: [{ id: 'worker', baseURL: 'https://worker.example/v1', models: ['worker-model'] },
        { id: 'vision', baseURL: 'https://vision.example/v1', models: ['vision-model'] }],
      dshProviderKeys: { worker: 'test-key', vision: 'vision-key' } });
    const calls = [];
    globalThis.fetch = async (_url, options) => {
      const request = JSON.parse(options.body);
      calls.push(request);
      return new Response(JSON.stringify({ choices: [{ message: { content: request.model === 'vision-model' ? '画面事实' : '含义解释' } }] }),
        { status: 200, headers: { 'Content-Type': 'application/json' } });
    };
    const imageResult = await getImagePartsOrVideo('image', [{ dataUrl: 'data:image/png;base64,aGVsbG8=' }], { store, chatKey: 'group:1' });
    assert.deepEqual(calls.map((r) => r.model), ['vision-model', 'worker-model']);
    assert.ok(calls[0].messages[1].content.some((p) => p.type === 'image_url'));
    assert.ok(!JSON.stringify(calls[1]).includes('base64'));
    assert.ok(calls[1].messages[1].content.includes('不代写回复台词'));
    assert.ok(calls[1].messages[1].content.includes('不能当作新的挑衅'));
    assert.ok(imageResult.content.every((p) => p.type === 'text'));
    assert.ok(imageResult.content[0].text.includes('含义解释'));
    assert.ok(!buildToolDefs().some((t) => t.id === 'delegate_analysis'));
    calls.length = 0;
    const multi = await getImagePartsOrVideo('forward', [
      { dataUrl: 'data:image/png;base64,aA==' }, { dataUrl: 'data:image/png;base64,Yg==' }
    ], { store, chatKey: 'group:1' });
    assert.deepEqual(calls.map((r) => r.model), ['vision-model', 'vision-model', 'worker-model']);
    assert.equal(calls[0].messages[1].content.filter((p) => p.type === 'image_url').length, 1);
    assert.equal(calls[1].messages[1].content.filter((p) => p.type === 'image_url').length, 1);
    assert.ok(multi.content[0].text.includes('第 1 张') && multi.content[0].text.includes('第 2 张'));
    const { getConfig } = await import('../src/config.js');
    const savedProviders = getConfig().providers;
    updateConfig({ providers: [...savedProviders, { id: 'orca', baseURL: 'https://api.orcarouter.ai/v1' }], dshProviderKeys: { orca: 'test-orca-key' } });
    calls.length = 0;
    await getImagePartsOrVideo('mixed images', [
      { dataUrl: 'data:image/jpeg;base64,aA==', isGif: true, gifSheet: true },
      { dataUrl: 'data:image/png;base64,Yg==' }
    ], { store, chatKey: 'group:1' });
    assert.deepEqual(calls.map((r) => r.model), ['vision-model', 'vision-model', 'worker-model']);
    assert.match(calls[0].messages[1].content[0].text, /时间顺序/);
    updateConfig({ providers: savedProviders });
    globalThis.fetch = async (_url, options) => {
      const request = JSON.parse(options.body);
      if (request.model === 'worker-model') throw new Error('getaddrinfo ENOTFOUND api.orcarouter.ai');
      return new Response(JSON.stringify({ choices: [{ message: { content: '已看清图片文字' } }] }));
    };
    const fallback = await getImagePartsOrVideo('image', [{ dataUrl: 'data:image/png;base64,aGVsbG8=' }], { store, chatKey: 'group:1' });
    assert.ok(fallback.content[0].text.includes('已看清图片文字'));
    assert.ok(fallback.content[0].text.includes('含义分析渠道暂不可用'));
    const { loadStickerStore, saveStickerStore, applyStickerNote, buildStickerContext, mergeStickerLibrary } = await import('../src/stickers.js');
    const stickerFile = path.join(dir, 'test-stickers.json');
    saveStickerStore([{ id: 'cached-face', url: 'https://image.example/face' }], stickerFile);
    const stickers = {
      find: async (id) => loadStickerStore(stickerFile).find((s) => s.id === id),
      note(id, patch) {
        const result = applyStickerNote(loadStickerStore(stickerFile), id, patch);
        saveStickerStore(result.entries, stickerFile);
        return result.entry;
      }
    };
    await getImagePartsOrVideo('sticker', [{ dataUrl: 'data:image/png;base64,aGVsbG8=' }], { store, chatKey: 'group:1', stickers, imageStickerId: 'cached-face' });
    assert.ok(loadStickerStore(stickerFile)[0].localNote.includes('已看清图片文字'));
    globalThis.fetch = async () => { throw new Error('Cached sticker must not call vision'); };
    const cachedSticker = await executeTool(buildToolDefs(), { stickers }, 'get_sticker_image', { stickerId: 'cached-face' });
    assert.equal(JSON.parse(cachedSticker.content).cached, true);
    assert.ok(buildStickerContext(loadStickerStore(stickerFile)).includes('已看清图片文字'));
    stickers.note('cached-face', { note: '用户纠正的含义' });
    assert.equal(mergeStickerLibrary(loadStickerStore(stickerFile), [{ id: 'cached-face', desc: '' }])[0].localNote, '用户纠正的含义');
    globalThis.fetch = async (_url, options) => {
      const request = JSON.parse(options.body);
      if (request.model === 'worker-model') throw new Error('worker unavailable');
      return new Response(JSON.stringify({ choices: [{ message: { content: '已看清图片文字' } }] }));
    };
    store.appendIncoming('group:1', { mid: 3, text: '[合并转发 共2条] [图片]', media: [{ kind: 'image', url: 'https://image.example/test' }] });
    const forward = await executeTool(buildToolDefs(), { chatKey: 'group:1', store }, 'read_forward', { messageId: 3 });
    assert.equal(JSON.parse(forward.content).images, 1);
    assert.ok(JSON.parse(forward.content).note.includes('get_message_images'));
    store.appendIncoming('group:1', { mid: 4, text: '[图片]', media: [{ kind: 'image', url: 'https://image.example/claude' }] });
    await getImagePartsOrVideo('image', [{ dataUrl: 'data:image/png;base64,aGVsbG8=' }], { store, chatKey: 'group:1', imageMessageId: 4 });
    assert.ok(new ChatStore().findByMid('group:1', 4).visualSummary.includes('已看清图片文字'));
    const { buildPastState } = await import('../src/prompt.js');
    assert.ok(buildPastState(store, 'group:1').text.includes('先前视觉观察'));
    store.markRecalled('group:1', 4);
    assert.ok(!buildPastState(store, 'group:1').text.includes('已看清图片文字'));
    const { skillManager } = await import('../src/skills/manager.js');
    const originalProviders = skillManager.getCapabilityProviders;
    let failedCalls = 0;
    skillManager.getCapabilityProviders = (cap) => cap === 'llm.endpoint-pick'
      ? [{ fn: () => ({ id: 'same', baseUrl: 'https://vision.example/v1/', model: 'vision-model', apiKey: 'vision-key' }) }]
      : [];
    globalThis.fetch = async () => { failedCalls++; throw new DOMException('The operation was aborted due to timeout', 'TimeoutError'); };
    try {
      await assert.rejects(getImagePartsOrVideo('消息 5', [{ dataUrl: 'data:image/png;base64,aGVsbG8=' }], { store, chatKey: 'group:1', imageStickerId: 'cached-face', stickers }), /不能推断内容/);
      assert.equal(failedCalls, 1, 'Do not retry the identical vision endpoint after failure');
      assert.equal(loadStickerStore(stickerFile)[0].localNote, '用户纠正的含义');
    } finally { skillManager.getCapabilityProviders = originalProviders; }
  } finally { globalThis.fetch = originalFetch; }
  console.log('PASS: history dedup/read/order/persistence; isolated bounded subagent');
} finally { fs.rmSync(dir, { recursive: true, force: true }); }
