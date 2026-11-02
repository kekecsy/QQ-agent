// Opt-in model/tool replay. Collect replies locally without connecting to OneBot.
import assert from 'node:assert/strict';
import { getConfig } from '../src/config.js';
import { chatCompletion } from '../src/llm.js';
import { internals, setup } from '../skills/ygo-ruling/index.js';

const cases = [
  { id: 'description', expected: /磁石战士(?:Ω\+|欧米伽[+＋])/, messages: [{ role: 'user', content: '查卡 磁石战士 破坏手牌场上一个本家从手牌墓地特殊召唤的那个' }] },
  { id: 'correction', expected: /磁石战士(?:Ω\+|欧米伽[+＋])/, messages: [
    { role: 'user', content: '查卡 磁石战士 破坏手牌场上一个本家从手牌墓地特殊召唤的那个' },
    { role: 'assistant', content: '你说的应该是磁石战士 电磁地神，8星的那只。' },
    { role: 'user', content: '不是，是4星的' }
  ] },
  { id: 'continuous-trap-search', expected: /法老(?:的)?降临/, firstQuery: args => !args.keyword && args.level === 8 && args.effectKeywords?.includes('永续陷阱'), messages: [{ role: 'user', content: '查卡 可以检索永续陷阱的一个8星怪兽' }] },
  { id: 'effect-object-level', firstQuery: args => !args.keyword && args.level === undefined && args.levelMin === undefined && args.levelMax === undefined && args.effectKeywords?.includes('8星'), messages: [{ role: 'user', content: '查卡 能从卡组把8星怪兽加入手卡的卡，名字和卡本身等级忘了' }] }
];
const caseId = process.argv.includes('--case') ? process.argv[process.argv.indexOf('--case') + 1] : null;
const selected = caseId ? cases.filter(c => c.id === caseId) : cases.filter(c => c.expected);
if (!selected.length) throw new Error(`Unknown case: ${caseId}`);
const firstOnly = process.argv.includes('--first-only');
if (!process.argv.includes('--run')) {
  console.log(JSON.stringify({ mode: 'dry', cases: selected.map(({ firstQuery, expected, ...test }) => test), firstOnly, systemChars: internals.leanSystem().length }));
} else {
  const defs = new Map();
  setup({ config: () => getConfig().skills?.['ygo-ruling'] || {}, log: () => {}, registerTool: def => defs.set(def.id, def) });
  const toolDefs = ['search_card', 'get_card', 'send_card_image'].map(id => ({
    type: 'function', function: { name: `ygo-ruling__${id}`, description: defs.get(id).description, parameters: defs.get(id).parameters }
  })).concat([
    { type: 'function', function: { name: 'send_message', description: '提交回复给本地测试收集器，不发送到QQ', parameters: { type: 'object', properties: { messages: { type: 'string' } }, required: ['messages'] } } },
    { type: 'function', function: { name: 'finish', description: '结束本次', parameters: { type: 'object', properties: { summary: { type: 'string' } } } } }
  ]);
  for (const test of selected) {
    const messages = [{ role: 'system', content: internals.leanSystem() }, ...test.messages];
    const sent = [];
    const called = [];
    let verified = false;
    for (let round = 0; round < (firstOnly ? 1 : 8) && !sent.length; round++) {
      const response = await chatCompletion({ messages, tools: toolDefs, maxTokens: 1800, signal: AbortSignal.timeout(60000) });
      const msg = response.message || {};
      if (!msg.tool_calls?.length) break;
      if (round === 0 && test.firstQuery) {
        const first = msg.tool_calls[0];
        const args = JSON.parse(first.function.arguments);
        console.log(JSON.stringify({ case: test.id, first: { name: first.function.name, args } }));
        assert.equal(first.function.name, 'ygo-ruling__search_card', 'first action must retrieve cards instead of guessing a name');
        assert.ok(test.firstQuery(args), `${test.id}: first query must separate card identity from effect description`);
      }
      messages.push({ role: 'assistant', content: msg.content || '', tool_calls: msg.tool_calls });
      for (const call of msg.tool_calls) {
        const name = call.function.name;
        const args = JSON.parse(call.function.arguments);
        called.push({ name, args });
        let result;
        if (name === 'ygo-ruling__send_card_image') {
          sent.push(`${args.card || ''}\n${args.note || ''}`);
          result = { content: '测试收集器已记录卡片与文案，未发送QQ。' };
        } else if (name === 'send_message') {
          sent.push(args.messages);
          result = { content: '测试收集器已记录文字，未发送QQ。' };
        } else if (name === 'finish') result = { content: '测试结束。' };
        else {
          const id = name.replace(/^ygo-ruling__/, '');
          if (!['search_card', 'get_card'].includes(id)) throw new Error(`Unexpected tool ${name}`);
          result = await defs.get(id).execute({}, args);
          if (!result.isError && test.expected?.test(result.content) && result.content.includes('效果文本：')) verified = true;
        }
        messages.push({ role: 'tool', tool_call_id: call.id, content: result.content });
      }
    }
    console.log(JSON.stringify({ case: test.id, called, verified, sent }));
    if (firstOnly) {
      assert.ok(called.length, 'model must actually call a tool');
      continue;
    }
    assert.ok(test.expected, 'this case checks only parameter binding; use --first-only');
    assert.ok(verified, `${test.id}: must retrieve the actual target effect, not just guess a name`);
    assert.equal(sent.length, 1, `${test.id}: expected one collected reply`);
    assert.match(sent[0], test.expected);
    assert.doesNotMatch(sent[0], /你说的(?:应该|应当|就是)是磁石战士 电磁地神/);
  }
}
