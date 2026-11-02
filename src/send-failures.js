import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { DATA_DIR } from './config.js';

const file = path.join(DATA_DIR, 'send-failures.json');
function load() {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
}
function save(rows) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(rows, null, 2));
  fs.renameSync(tmp, file);
}
export function sendIdentity(action, params) {
  const kind = action === 'send_group_msg' ? 'group' : 'private';
  const chatKey = `${kind}:${params[`${kind}_id`]}`;
  // Reply/at prefixes do not change the content whose delivery is tracked.
  const content = Array.isArray(params.message) ? params.message.filter((s) => !['reply', 'at'].includes(s.type)) : params.message;
  const id = createHash('sha256').update(JSON.stringify({ chatKey, content })).digest('hex');
  const text = Array.isArray(content) ? content.filter((s) => s.type === 'text').map((s) => s.data?.text || '').join('') : String(content || '');
  const reply = Array.isArray(params.message) ? params.message.find((s) => s.type === 'reply')?.data?.id : null;
  return { id, chatKey, text: text.slice(0, 6000), types: Array.isArray(content) ? content.map((s) => s.type) : ['text'], sourceMids: reply == null ? [] : [String(reply)] };
}
export function recordSendFailure(identity, error) {
  const rows = load().filter((r) => r.updatedAt >= Date.now() - 12 * 3600000);
  const old = rows.find((r) => r.id === identity.id);
  const row = { ...identity, sourceMids: old?.sourceMids?.length ? old.sourceMids : identity.sourceMids, updatedAt: Date.now(), error: String(error).slice(0, 300), status: 'failed' };
  save([...rows.filter((r) => r.id !== identity.id), row]);
}
export function clearSendFailure(identity) {
  const rows = load();
  if (rows.some((r) => r.id === identity.id)) save(rows.filter((r) => r.id !== identity.id));
}
export function suspendSendFailure(identity) {
  const rows = load();
  const row = rows.find((r) => r.id === identity.id);
  if (row) { row.status = 'unknown'; save(rows); }
}
export function listSendFailures(chatKey, now = Date.now()) {
  return load().filter((r) => r.chatKey === chatKey && r.status === 'failed' && r.updatedAt >= now - 12 * 3600000);
}
export function bindSendFailures(chatKey, since, mids) {
  const rows = load();
  let changed = false;
  for (const row of rows) {
    if (row.chatKey === chatKey && row.updatedAt >= since && !row.sourceMids.length) {
      row.sourceMids = mids.filter((m) => m != null).map(String);
      changed = true;
    }
  }
  if (changed) save(rows);
}
