// Opt-in live-model check; no OneBot connection or real message sending.
import { getConfig } from '../src/config.js';
import { chatCompletion, resolveApiKey } from '../src/llm.js';
import * as ruling from '../skills/ygo-ruling/index.js';
import { searchRuleBook } from '../skills/ygo-ruling/rule-knowledge.mjs';

const question = '裁定 对方回合，我方C1发动自己场上怪兽的效果，对方C2用鲜花之女男爵②使那个发动无效并破坏我方怪兽。我方能否C3连锁鲜花，发动神圣心灵防护罩 -心灵之力-？假设我方怪兽仍在场、可被破坏，防护罩已在上一回合盖放，无其他发动限制。';
const lean = ruling.internals.leanContextFor({ reach: { addressed: true }, triggerEntries: [{ text: question }] });
if (!process.argv.includes('--run')) {
  console.log(JSON.stringify({ mode: 'dry', historyLimit: lean.historyLimit, systemChars: lean.system.length, question }));
} else {
  const defs = new Map();
  ruling.setup({ config: () => getConfig().skills?.['ygo-ruling'] || {}, registerTool: (d) => defs.set(d.id, d), log: () => {} });
  const evidence = [];
  for (const id of ['get_card', 'get_script']) {
    const result = await defs.get(id).execute({}, { cards: '神圣心灵防护罩 -心灵之力-,鲜花之女男爵' });
    if (result.isError) throw new Error(`${id} evidence unavailable`);
    evidence.push({ role: 'user', content: `已由本地${id}工具取得的资料（非历史模型结论）：\n${result.content}` });
  }
  const book = searchRuleBook(['发动无效并破坏', '场上', '怪兽'], 3, '5.3');
  if (!book.isError) evidence.push({ role: 'user', content: book.content });
  const response = await chatCompletion({
    messages: [{ role: 'system', content: lean.system }, ...evidence, { role: 'user', content: question }],
    tools: [{ type: 'function', function: { name: 'send_message', description: '提交给测试收集器，不会发送到QQ', parameters: { type: 'object', properties: { messages: { type: 'string' } }, required: ['messages'] } } }],
    overrides: process.argv.includes('--thinking') ? { ...getConfig().api, apiKey: resolveApiKey(getConfig()), thinkingEffort: 'high' } : null,
    maxTokens: process.argv.includes('--thinking') ? 5000 : 900, signal: AbortSignal.timeout(90000)
  });
  const calls = response.message?.tool_calls || [];
  const texts = calls.filter((c) => c.function?.name === 'send_message').map((c) => JSON.parse(c.function.arguments).messages);
  console.log(JSON.stringify({ model: getConfig().api.model, submitted: texts, content: response.message?.content || '', usage: response.usage }));
  if (texts.length !== 1) throw new Error('Expected exactly one collected send_message call');
}
