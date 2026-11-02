import { searchMemes, rememberMeme, forgetMeme } from '../../src/local-memes.js';
const response = (fn) => async (ctx, args = {}) => {
  try { return { content: JSON.stringify(await fn(ctx, args)) }; }
  catch (e) { return { content: `梗记录操作失败：${e.message}`, isError: true }; }
};
export function promptSections() {
  return [{ id: 'group-memes-guide', title: '本群梗记录', priority: 40, content: '遇到需要前情的本群内部梗，按需用 group-memes__search_meme 查；普通表情或公开文案梗不必每次查或联网。只有群友明确解释、要求记住或重复确认的内容才记，remember_meme 必须给真实来源消息id和逐字证据，不把自己猜测当事实。needs-confirmation 只是待确认，不要据此下定论。记录不跨群，不含私密信息。可按群友明确要求修正或忘掉。整本梗库不放入系统提示词。' }];
}
export function setup(api) {
  api.registerTool({ id: 'search_meme', name: '查本群梗', category: 'query', description: '仅检索当前群/私聊的本地梗记录，返回来源和确认状态，不联网。', parameters: { type: 'object', properties: { query: { type: 'string' } } }, execute: response((ctx, args) => searchMemes(ctx, args.query)) });
  api.registerTool({ id: 'remember_meme', name: '记本群梗', category: 'memory', description: '记住群友解释或确认过的梗；来源必须是本会话真实消息，不允许模型猜测编造。', parameters: { type: 'object', properties: { name: { type: 'string' }, aliases: { type: 'array', items: { type: 'string' } }, meaning: { type: 'string' }, usage: { type: 'string' }, evidenceQuote: { type: 'string', description: '逐字引用来源中的解释，不改写' }, sourceMessageIds: { type: 'array', items: { type: ['integer', 'string'] }, minItems: 1, maxItems: 5 } }, required: ['name', 'meaning', 'evidenceQuote', 'sourceMessageIds'] }, execute: response(rememberMeme) });
  api.registerTool({ id: 'forget_meme', name: '忘记本群梗', category: 'memory', description: '仅在群友明确要求删除该梗时使用，给出该请求的消息id。', parameters: { type: 'object', properties: { name: { type: 'string' }, requestMessageId: { type: ['integer', 'string'] } }, required: ['name', 'requestMessageId'] }, execute: response((ctx, args) => ({ removed: forgetMeme(ctx, args.name, args.requestMessageId) })) });
}
