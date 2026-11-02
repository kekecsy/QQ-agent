import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config.js';
import { invalidateDerivedHistory } from './derived-history.js';

export const JOURNAL_DIR = path.join(DATA_DIR, 'messages-jsonl');
const snapshots = new WeakMap();
export function chatName(key) {
  if (!/^(group|private):\d+$/.test(key)) throw new Error('非法会话标识');
  return key.replace(':', '_');
}
export function chinaDate(ts = Date.now()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ts));
}
function events(dir) {
  const result = [];
  for (const name of fs.readdirSync(dir).filter((n) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(n)).sort()) {
    const file = path.join(dir, name);
    const raw = fs.readFileSync(file, 'utf8');
    const lines = raw.split('\n');
    let offset = 0;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line.trim()) {
        try { result.push(JSON.parse(line)); }
        catch (e) {
          if (i !== lines.length - 1 || raw.endsWith('\n')) throw new Error(`聊天日志损坏：${name}:${i + 1}`);
          // Preserve a torn final write before removing it. Never skip corruption in the middle.
          fs.writeFileSync(`${file}.incomplete-${Date.now()}`, line);
          fs.truncateSync(file, offset);
        }
      }
      offset += Buffer.byteLength(line + '\n');
    }
    if (raw && !raw.endsWith('\n') && lines.at(-1).trim()) {
      try { JSON.parse(lines.at(-1)); fs.appendFileSync(file, '\n'); } catch { /* torn tail was removed above */ }
    }
  }
  return result.sort((a, b) => a.seq - b.seq);
}
function replay(key, dir) {
  const messages = new Map();
  let nextLocalId = 1;
  let seq = 0;
  for (const e of events(dir)) {
    if (e.version !== 1 || !Number.isSafeInteger(e.seq) || e.seq <= seq) throw new Error('聊天日志版本或序号无效');
    seq = e.seq;
    if (e.op === 'put') messages.set(e.message.id, e.message);
    else if (e.op === 'delete') messages.delete(e.id);
    else if (e.op !== 'meta') throw new Error('未知聊天日志事件');
    if (e.nextLocalId) nextLocalId = Math.max(nextLocalId, e.nextLocalId);
    if (e.message) nextLocalId = Math.max(nextLocalId, e.message.id + 1);
  }
  return { state: { chatKey: key, nextLocalId, messages: [...messages.values()].sort((a, b) => a.ts - b.ts || a.id - b.id) }, seq };
}
function remember(state, seq) {
  snapshots.set(state, { seq, nextLocalId: state.nextLocalId, records: new Map(state.messages.map((m) => [m.id, JSON.stringify(m)])) });
}
export function loadJournal(key) {
  const name = chatName(key);
  const dir = path.join(JOURNAL_DIR, name);
  if (!fs.existsSync(path.join(dir, 'format.json'))) {
    if (fs.existsSync(dir)) throw new Error('聊天日志缺少格式标记，拒绝覆盖');
    const legacy = path.join(DATA_DIR, 'messages', `${name}.json`);
    let state = { chatKey: key, nextLocalId: 1, messages: [] };
    if (fs.existsSync(legacy)) {
      state = JSON.parse(fs.readFileSync(legacy, 'utf8').replace(/^\uFEFF/, ''));
      if (!Array.isArray(state.messages) || !Number.isSafeInteger(state.nextLocalId)) throw new Error('旧聊天存档格式错误');
      state.chatKey = key;
    }
    fs.mkdirSync(JOURNAL_DIR, { recursive: true });
    const temp = fs.mkdtempSync(path.join(JOURNAL_DIR, `.${name}-migration-`));
    try {
      let seq = 0;
      for (const message of state.messages) {
        fs.appendFileSync(path.join(temp, `${chinaDate(message.ts)}.jsonl`), JSON.stringify({ version: 1, seq: ++seq, op: 'put', message }) + '\n');
      }
      fs.appendFileSync(path.join(temp, `${chinaDate()}.jsonl`), JSON.stringify({ version: 1, seq: ++seq, op: 'meta', nextLocalId: state.nextLocalId }) + '\n');
      const verified = replay(key, temp).state;
      const original = [...state.messages].sort((a, b) => a.ts - b.ts || a.id - b.id);
      if (JSON.stringify(verified.messages) !== JSON.stringify(original) || verified.nextLocalId !== state.nextLocalId) throw new Error('JSONL 迁移校验失败');
      fs.writeFileSync(path.join(temp, 'format.json'), JSON.stringify({ version: 1, legacyRetained: fs.existsSync(legacy), importedCount: state.messages.length, migratedAt: new Date().toISOString() }));
      fs.renameSync(temp, dir);
    } finally { fs.rmSync(temp, { recursive: true, force: true }); }
  }
  const loaded = replay(key, dir);
  remember(loaded.state, loaded.seq);
  return loaded.state;
}
export function saveJournal(state) {
  const previous = snapshots.get(state);
  if (!previous) throw new Error('聊天日志未初始化');
  const dir = path.join(JOURNAL_DIR, chatName(state.chatKey));
  const records = new Map();
  const batches = new Map();
  const invalidated = new Set();
  let seq = previous.seq;
  const add = (date, event) => {
    if (!batches.has(date)) batches.set(date, []);
    batches.get(date).push(JSON.stringify({ version: 1, seq: ++seq, ...event }));
  };
  for (const message of state.messages) {
    const raw = JSON.stringify(message);
    records.set(message.id, raw);
    const old = previous.records.get(message.id);
    const semantic = (m) => JSON.stringify([m.ts, m.senderId, m.senderName, m.text, m.reply, m.self, m.recalled, m.visualSummary]);
    if (old && semantic(JSON.parse(old)) !== semantic(message)) invalidated.add(message.id);
    if (previous.records.get(message.id) !== raw) add(chinaDate(message.ts), { op: 'put', message });
  }
  for (const id of previous.records.keys()) if (!records.has(id)) { add(chinaDate(), { op: 'delete', id }); invalidated.add(id); }
  if (state.nextLocalId !== previous.nextLocalId) add(chinaDate(), { op: 'meta', nextLocalId: state.nextLocalId });
  // A failed partial commit must not silently reuse sequence numbers.
  try {
    for (const [date, lines] of batches) {
      const fd = fs.openSync(path.join(dir, `${date}.jsonl`), 'a');
      try { fs.writeFileSync(fd, lines.join('\n') + '\n'); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    }
  } catch (e) { snapshots.delete(state); throw e; }
  remember(state, seq);
  invalidateDerivedHistory(chatName(state.chatKey), invalidated);
}
