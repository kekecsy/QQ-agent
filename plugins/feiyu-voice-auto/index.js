export { settingsActions } from '../../skills/feiyu-voice/service-manager.js';
let api;
let random = Math.random;
let attempted = new WeakSet();
let explicitVoice = new WeakSet();

export function probability(value = 20) {
  const n = value === '' || value == null ? 20 : Number(value);
  return Number.isFinite(n) ? Math.max(0, Math.min(100, n)) : 20;
}

export function speechText(messages, maxChars) {
  if (!Array.isArray(messages) || !messages.length || messages.some(s => typeof s !== 'string')) return null;
  const text = messages.join('。').replace(/。{2,}/g, '。').trim();
  if (!text || [...text].length > maxChars || !/[\p{L}\p{N}]/u.test(text)) return null;
  // Preserve rich formatting, links and QQ control syntax as text.
  if (/https?:\/\/|www\.|\[CQ:|`|\n\s*[-*#>]|\[[^\]]+\]\(|\*\*|<tool_call|@\d+/i.test(text)) return null;
  return text;
}

export async function deliver({ ctx, messages, options = {} }) {
  if (!ctx.session || typeof ctx.session !== 'object' || attempted.has(ctx.session) || explicitVoice.has(ctx.session)) return;
  if (ctx.session.sent?.some(s => s.type === 'voice')) return;
  if (api.isEnabledForChat?.(ctx.chatKey) === false) return;
  if (options.replyToMessageId != null || options.atUserId != null) return;
  const chance = probability(api.config().probability);
  if (chance === 0) return;
  const state = await api.capability('voice.feiyu.state', { chatKey: ctx.chatKey });
  if (!state || state.busy || state.cooldownRemainingMs > 0) return;
  const text = speechText(messages, state.maxChars);
  if (!text) return;
  attempted.add(ctx.session);
  if (chance < 100 && random() >= chance / 100) return;
  if (api.isEnabledForChat?.(ctx.chatKey) === false) return;
  const result = await api.capability('voice.feiyu.send', { ctx, text, style: state.style, recordSession: false,
    allowDelivery: () => api.isEnabledForChat?.(ctx.chatKey) !== false });
  if (result?.isError || !result?.delivery) {
    api.warn?.('概率语音未完成，保留原文字回复');
    return;
  }
  return { handled: true, delivery: 'voice', sent: [result.delivery], failed: [] };
}

export const providers = { 'message.deliver-text': deliver };
export const hooks = {
  'after-response': ({ response, session }) => {
    const message = response?.message;
    const nativeVoice = message?.tool_calls?.some(call => /^(feiyu-voice|manbo-voice)__send_voice$/.test(call.function?.name));
    const inlineVoice = typeof message?.content === 'string' && /(?:feiyu-voice|manbo-voice)__send_voice/.test(message.content);
    if (session && (nativeVoice || inlineVoice)) {
      explicitVoice.add(session);
    }
  }
};

export function setup(skillApi, { rng = Math.random } = {}) {
  api = skillApi;
  random = rng;
  attempted = new WeakSet();
  explicitVoice = new WeakSet();
}
