import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { DATA_DIR } from './config.js';
import { chatName } from './chat-journal.js';
import { visibleMessages } from './history-policy.js';

export const messageHash = (m) => createHash('sha256').update(JSON.stringify([m.id, m.ts, m.senderId, m.text, m.reply])).digest('hex');
const file = (key) => path.join(DATA_DIR, 'memes', `${chatName(key)}.json`);
const normalize = (s) => String(s || '').trim().toLowerCase();
function read(key) {
  try { return JSON.parse(fs.readFileSync(file(key), 'utf8')); }
  catch (e) { if (e.code === 'ENOENT') return { version: 1, entries: [] }; throw e; }
}
function save(key, data) {
  fs.mkdirSync(path.dirname(file(key)), { recursive: true });
  fs.writeFileSync(`${file(key)}.tmp`, JSON.stringify(data, null, 2));
  fs.renameSync(`${file(key)}.tmp`, file(key));
}
export function searchMemes(ctx, query = '') {
  const data = read(ctx.chatKey);
  let changed = false;
  for (const entry of data.entries) {
    if (entry.invalidated) continue;
    const valid = entry.sources.every((s) => {
      const m = ctx.store.findByLocalId(ctx.chatKey, s.localId);
      return m && visibleMessages(ctx.chatKey, [m]).length && messageHash(m) === s.hash;
    });
    if (!valid) {
      entry.invalidated = true;
      entry.meaning = '';
      entry.usage = '';
      entry.evidenceQuote = '';
      changed = true;
    }
  }
  if (changed) save(ctx.chatKey, data);
  const q = normalize(query);
  return data.entries.filter((e) => !e.invalidated && (!q || [e.name, ...e.aliases, e.meaning].some((s) => normalize(s).includes(q)))).slice(0, 12);
}
export function rememberMeme(ctx, args) {
  const name = String(args.name || '').trim().slice(0, 50);
  const meaning = String(args.meaning || '').trim().slice(0, 400);
  const quote = String(args.evidenceQuote || '').trim().slice(0, 500);
  if (!name || !meaning || quote.length < 4) throw new Error('需要梗名、含义和来自群友原话的证据引用');
  if (/https?:\/\/|(?:sk-|nvapi-|rc-)[a-z0-9_-]{10,}|\b\d{7,}\b/i.test(name + meaning + quote)) throw new Error('内容可能包含账号、链接或密钥，暂不记录');
  const mids = [...new Set((args.sourceMessageIds || []).map(String))].slice(0, 5);
  const messages = mids.map((mid) => ctx.store.findByMid(ctx.chatKey, mid));
  if (!messages.length || messages.some((m) => !m || m.self || !visibleMessages(ctx.chatKey, [m]).length)) throw new Error('来源消息缺失、已撤回、已删除或被屏蔽');
  if (!messages.some((m) => String(m.text).includes(quote))) throw new Error('证据引用必须逐字来自本会话群友消息，不能编造');
  const aliases = (Array.isArray(args.aliases) ? args.aliases : []).map((s) => String(s).trim().slice(0, 40)).filter(Boolean).slice(0, 8);
  if (![name, ...aliases].some((n) => messages.some((m) => String(m.text).includes(n) || String(m.reply?.text || '').includes(n)))) throw new Error('来源没有提到此梗名或别名，请先确认');
  const confirmed = /意思|是指|指的是|这个梗|记住|叫做|就是|用来|表示/.test(quote);
  const data = read(ctx.chatKey);
  const previous = data.entries.findIndex((e) => normalize(e.name) === normalize(name));
  const entry = { name, aliases, meaning, usage: String(args.usage || '').slice(0, 300), evidenceQuote: quote, status: confirmed ? 'source-backed' : 'needs-confirmation', sources: messages.map((m) => ({ localId: m.id, messageId: m.mid, hash: messageHash(m) })), updatedAt: new Date().toISOString() };
  if (previous < 0) data.entries.push(entry); else data.entries[previous] = entry;
  save(ctx.chatKey, data);
  return entry;
}
export function forgetMeme(ctx, name, requestMessageId) {
  const request = ctx.store.findByMid(ctx.chatKey, requestMessageId);
  if (!request || request.self || !visibleMessages(ctx.chatKey, [request]).length || !String(request.text).includes(name) || !/删除|忘掉|忘记|别记|不要记|移除/.test(request.text)) throw new Error('删除需要群友明确要求，并提供该请求消息id');
  const data = read(ctx.chatKey);
  const before = data.entries.length;
  data.entries = data.entries.filter((e) => normalize(e.name) !== normalize(name));
  save(ctx.chatKey, data);
  return before - data.entries.length;
}
