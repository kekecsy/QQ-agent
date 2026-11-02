import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nested-forward-'));
process.env.QQ_AGENT_DATA_DIR = dir;
try {
  const { ChatStore } = await import('../src/store.js');
  const { buildToolDefs, executeTool } = await import('../src/tools.js');
  const store = new ChatStore();
  store.appendIncoming('group:1', { mid: 123, text: '[合并转发聊天记录]' });
  const calls = [];
  const ctx = { store, chatKey: 'group:1', onebot: { async call(action, args) {
    assert.equal(action, 'get_forward_msg');
    calls.push(args);
    if (args.message_id === 123) return { messages: [{ sender: { nickname: '甲' }, content: [
      { type: 'text', data: { text: '外层说明' } }, { type: 'forward', data: { id: 'inner' } },
    ] }] };
    if (args.id === 'inner') return { messages: [{ sender: { nickname: '乙' }, content: [
      { type: 'text', data: { text: '内层文字' } }, { type: 'forward', data: { id: 'deep' } },
    ] }] };
    if (args.id === 'deep') return { messages: [{ sender: { nickname: '丙' }, content: [
      { type: 'text', data: { text: '最内层文字' } }, { type: 'image', data: { url: 'https://example.com/nested.png' } },
    ] }] };
    throw Error('unexpected lookup');
  } } };
  const tools = buildToolDefs();
  const result = JSON.parse((await executeTool(tools, ctx, 'read_forward', { messageId: 123 })).content);
  assert.match(result.text, /最内层文字/);
  assert.match(result.text, /甲/);
  assert.match(result.text, /乙/);
  assert.match(result.text, /丙/);
  assert.equal(result.images, 1);
  assert.equal(calls.length, 3);
  const cached = JSON.parse((await executeTool(tools, ctx, 'read_forward', { messageId: 123 })).content);
  assert.match(cached.text, /最内层文字/);
  assert.equal(calls.length, 3);
  assert.equal(store.findByMid('group:1', 123).media[0].url, 'https://example.com/nested.png');
  // Old one-level caches must be expanded again instead of treated as complete.
  store.updateByMid('group:1', 123, { text: '[合并转发 共1条]\n甲: [合并转发聊天记录]' });
  const upgraded = JSON.parse((await executeTool(tools, ctx, 'read_forward', { messageId: 123 })).content);
  assert.match(upgraded.text, /最内层文字/);
  assert.equal(calls.length, 6);
  await executeTool(tools, ctx, 'read_forward', { messageId: 123, refresh: true });
  assert.equal(calls.length, 9);
  const { expandForwardNodes } = await import('../src/onebot.js');
  const text = (value) => ({ type: 'text', data: { text: value } });
  const forward = (id) => ({ type: 'forward', data: { id } });
  const node = (content) => ({ nickname: '甲', content });
  const inline = await expandForwardNodes([node([
    { type: 'forward', data: { content: [{ type: 'node', data: node([text('内嵌节点文字')]) }] } },
    { type: 'node', data: node([text('直接节点文字')]) },
  ])]);
  assert.match(inline.text, /内嵌节点文字/);
  assert.match(inline.text, /直接节点文字/);
  let lookups = 0;
  const cycle = await expandForwardNodes([node([forward('loop'), forward('loop')])], {
    resolveForward: async () => { lookups++; return { messages: [node([forward('loop')])] }; },
  });
  assert.match(cycle.text, /循环引用/);
  assert.equal(lookups, 1, 'repeated resources share a fetch, separate branches retain content');
  const failed = await expandForwardNodes([node([forward('bad'), text('失败后仍保留')])], {
    resolveForward: async () => { throw Error('expired'); },
  });
  assert.match(failed.text, /拉取失败/);
  assert.match(failed.text, /失败后仍保留/);
  const timeout = await expandForwardNodes([node([forward('slow'), text('超时后仍保留')])], {
    timeoutMs: 10, resolveForward: () => new Promise(() => {}),
  });
  assert.match(timeout.text, /超时/);
  assert.match(timeout.text, /超时后仍保留/);
  const depth = await expandForwardNodes([node([forward('loop')])], {
    maxDepth: 1, resolveForward: async () => ({ messages: [node([forward('loop2')])] }),
  });
  assert.match(depth.text, /深度上限/);
  const count = await expandForwardNodes([node([text('第一条')]), node([text('第二条')])], { maxNodes: 1 });
  assert.doesNotMatch(count.text, /第二条/);
  assert.match(count.text, /后续内容未展开/);
  const chars = await expandForwardNodes([node([text('长'.repeat(500))])], { maxChars: 40 });
  assert.ok(chars.text.length < 120);
  const budget = await expandForwardNodes([node([forward('one'), forward('two'), text('外层结尾')])], {
    maxFetches: 1, resolveForward: async () => ({ messages: [node([text('内层内容')])] }),
  });
  assert.match(budget.text, /请求上限/);
  assert.match(budget.text, /外层结尾/);
  console.log('PASS: nested read_forward, speakers/images, cache upgrade/refresh, inline nodes, cycles, failures, timeout and expansion bounds');
} finally { fs.rmSync(dir, { recursive: true, force: true }); }
