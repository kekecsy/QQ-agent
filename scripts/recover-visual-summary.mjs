import fs from 'node:fs';
import { ChatStore } from '../src/store.js';
import { visibleMessages } from '../src/history-policy.js';

const [sessionFile, messageId] = process.argv.slice(2);
if (!sessionFile || !messageId) throw new Error('Usage: node scripts/recover-visual-summary.mjs <session.json> <messageId>; stop QQ Agent first');
const session = JSON.parse(fs.readFileSync(sessionFile, 'utf8'));
let facts = '';
function visit(value) {
  if (!value || typeof value !== 'object') return;
  if (value.name === 'get_message_images' && String(value.args?.messageId) === messageId && !value.isError && typeof value.result === 'string') {
    facts = value.result.split('图片观察：')[1]?.split('\n含义分析')[0]?.trim() || '';
  }
  for (const child of Object.values(value)) if (typeof child === 'object') visit(child);
}
visit(session);
const store = new ChatStore();
const entry = store.findByMid(session.chatKey, messageId);
if (!facts || !entry || !visibleMessages(session.chatKey, [entry]).length) throw new Error('No valid source or visible message');
store.updateByMid(session.chatKey, messageId, { visualSummary: facts });
console.log(JSON.stringify({ chatKey: session.chatKey, messageId, restoredChars: Math.min(1800, facts.length) }));
