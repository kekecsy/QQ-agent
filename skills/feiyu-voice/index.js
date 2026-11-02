import fs from 'node:fs';
import { compactSpeechClip, joinTimedSpeech } from './speech-timing.js';
import { splitSpeech, synthesizeParts } from './speech-segments.js';
export { settingsActions } from './service-manager.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { DATA_DIR } from '../../src/config.js';
import { encodeQqVoice } from '../../src/voice-silk.js';

const root = process.env.QQ_AGENT_FEIYU_ROOT || fileURLToPath(new URL('../../../feiyu/', import.meta.url));
const cacheDir = path.join(DATA_DIR, 'feiyu-voice');
const baseUrl = 'http://127.0.0.1:9880';
const busy = new Set();
const lastSent = new Map();
const pendingAudio = new Map();
const pendingSegments = new Map();
let cfg = () => ({});
let httpFetch;
let encoder = encodeQqVoice;
let enabledForChat = () => true;
let pause = (ms) => new Promise((r) => setTimeout(r, ms));

async function request(route, options = {}) {
  const key = fs.readFileSync(path.join(root, '.runtime/voice-service/api_key.txt'), 'utf8').trim();
  const response = await httpFetch(baseUrl + route, { ...options, redirect: 'error',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(15000) });
  if (!response.ok) throw new Error(`本地声音服务 HTTP ${response.status}`);
  return response;
}

export async function audioFor(text, style) {
  const key = `timing-v1:${style}:${text}`;
  if (pendingAudio.has(key)) return pendingAudio.get(key);
  const pending = generateSpeech(text, style);
  pendingAudio.set(key, pending);
  try { return await pending; }
  finally { pendingAudio.delete(key); }
}

async function generateSpeech(text, style) {
  const parts = splitSpeech(text);
  if (!parts.length) throw new Error('语音文案需要包含文字或数字');
  fs.mkdirSync(cacheDir, { recursive: true });
  const hash = createHash('sha256').update(JSON.stringify(['feiyu-timing-v1', style, parts])).digest('hex');
  const file = path.join(cacheDir, `${hash}.wav`);
  if (fs.existsSync(file)) return file;
  const files = await synthesizeParts(parts, (phrase) => generateAudio(phrase, style));
  const clips = files.map((f) => compactSpeechClip(fs.readFileSync(f)));
  const audio = joinTimedSpeech(clips, parts);
  fs.writeFileSync(`${file}.tmp`, audio);
  fs.renameSync(`${file}.tmp`, file);
  return file;
}

async function generateAudio(text, style) {
  const key = `${style}:${text}`;
  if (pendingSegments.has(key)) return pendingSegments.get(key);
  const pending = downloadAudio(text, style);
  pendingSegments.set(key, pending);
  try { return await pending; }
  finally { pendingSegments.delete(key); }
}

async function downloadAudio(text, style) {
  fs.mkdirSync(cacheDir, { recursive: true });
  const hash = createHash('sha256').update(`feiyu-1.0.1:${style}:${text}`).digest('hex');
  const file = path.join(cacheDir, `${hash}.wav`);
  if (fs.existsSync(file)) return file;
  const submitted = await request('/v1/speech', { method: 'POST', body: JSON.stringify({ voice: 'feiyu', text, style }) });
  const { id } = await submitted.json();
  if (!/^[a-f0-9]{32}$/.test(id)) throw new Error('服务返回了无效的任务编号');
  const deadline = Date.now() + 600000;
  while (Date.now() < deadline) {
    const job = await (await request(`/v1/jobs/${id}`)).json();
    if (['failed', 'interrupted'].includes(job.status)) throw new Error(`合成任务${job.status}，请检查本地 inference.log`);
    if (job.status === 'success') {
      const response = await request(`/v1/jobs/${id}/audio`);
      const buffer = Buffer.from(await response.arrayBuffer());
      if (buffer.length < 44 || buffer.length > 5 * 1024 * 1024 || buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WAVE') throw new Error('服务返回的 WAV 无效或过大');
      fs.writeFileSync(`${file}.tmp`, buffer);
      fs.renameSync(`${file}.tmp`, file);
      return file;
    }
    await pause(1000);
  }
  throw new Error(`合成等待超时（任务 ${id}）；请检查原任务，不要立即重复提交`);
}

export async function sendVoice(ctx, args = {}, { automatic = false, recordSession = true, allowDelivery = () => true } = {}) {
  if (!ctx.chatKey || !ctx.sender?.sendMedia) return { content: '当前会话无法发送语音', isError: true };
  if (busy.has(ctx.chatKey)) return { content: '当前会话正在处理语音，请等待', isError: true };
  busy.add(ctx.chatKey);
  try {
    if (!enabledForChat(ctx.chatKey)) throw new Error('当前会话未启用肥鱼本地语音');
    if (!automatic && cfg().proactive !== true && args.requested !== true) throw new Error('仅在群友明确要求语音时调用');
    const text = String(args.text || '').trim();
    const maxChars = Math.max(1, Math.min(80, Number(cfg().maxChars) || 50));
    if (!text || [...text].length > maxChars) throw new Error(`请使用不超过${maxChars}字的短句`);
    const style = args.style || cfg().style || 'cute';
    if (!['cute', 'gentle'].includes(style)) throw new Error('声线只支持 cute 或 gentle');
    const cooldown = Math.max(0, Number(cfg().cooldownMinutes) || 0) * 60000;
    if (Date.now() - (lastSent.get(ctx.chatKey) || 0) < cooldown) throw new Error('语音发送冷却中，请稍后再试');
    const file = await audioFor(text, style);
    const audio = await encoder(file);
    if (!enabledForChat(ctx.chatKey) || !allowDelivery()) throw new Error('肥鱼语音已停用');
    const receipt = await ctx.sender.sendMedia(ctx.chatKey, [{ type: 'record', data: { file: `base64://${audio.toString('base64')}` } }],
      { label: `[肥鱼语音/${style}] ${text}`, dedupeKey: file });
    lastSent.set(ctx.chatKey, Date.now());
    const delivery = { type: 'voice', text, at: new Date().toLocaleTimeString('zh-CN', { hour12: false }), messageId: receipt?.message_id ?? null };
    if (recordSession && Array.isArray(ctx.session?.sent)) {
      ctx.session.sent.push(delivery);
      ctx.emit?.('session-update', ctx.session.id);
    }
    return { content: '肥鱼语音已发送。不重复发同文案文字，也不用汇报“已发送”。', delivery };
  } catch (e) {
    return { content: `肥鱼语音未发送：${e.message}。可改用文字；不要宣称发送成功。`, isError: true };
  } finally { busy.delete(ctx.chatKey); }
}

export const providers = {
  'voice.feiyu.state': ({ chatKey }) => {
    if (!enabledForChat(chatKey)) return;
    return { style: cfg().style || 'cute', maxChars: Math.max(1, Math.min(80, Number(cfg().maxChars) || 50)),
      busy: busy.has(chatKey), cooldownRemainingMs: Math.max(0,
        Math.max(0, Number(cfg().cooldownMinutes) || 0) * 60000 - (Date.now() - (lastSent.get(chatKey) || 0))) };
  },
  // Internal capability: the independently configured probability plugin owns
  // the automatic policy; a model tool cannot pass these execution options.
  'voice.feiyu.send': ({ ctx, text, style, recordSession, allowDelivery }) =>
    sendVoice(ctx, { text, style }, { automatic: true, recordSession, allowDelivery })
};

export function promptSections() {
  return [{ id: 'feiyu-local-voice', title: '肥鱼本地语音', priority: 47,
    content: `用户要求肥鱼语音、用你的声音说话时，调用 feiyu-voice__send_voice，将自己的一句短回复在本机合成为QQ语音。cute偏可爱，gentle偏温柔，默认${cfg().style || 'cute'}。${cfg().proactive === true ? '可以偶尔主动语音。' : '仅在用户明确要求语音时调用，requested=true。'}文案最多${Math.min(80, Number(cfg().maxChars) || 50)}字。不要提交整段聊天记录或冒充现实人物。生成可能需要等待，不重复调用；失败如实回退文字。用户明确要求曼波时才使用曼波工具。` }];
}

export function setup(api, { encodeVoice = encodeQqVoice, sleep = pause } = {}) {
  cfg = api.config;
  httpFetch = api.fetch;
  encoder = encodeVoice;
  enabledForChat = (chatKey) => api.isEnabledForChat?.(chatKey) !== false;
  pause = sleep;
  api.registerTool({ id: 'send_voice', name: '发送肥鱼本地语音', category: 'media',
    description: '将一句短回复用本机肥鱼声库合成，并作为QQ语音发送。支持cute可爱和gentle温柔两种声线。',
    parameters: { type: 'object', properties: { text: { type: 'string' }, style: { type: 'string', enum: ['cute', 'gentle'] }, requested: { type: 'boolean', description: '用户明确要求语音时填true' } }, required: ['text'] }, execute: sendVoice });
}
