import fs from 'node:fs';
import path from 'node:path';
import { ChatStore } from '../src/store.js';
import { DATA_DIR } from '../src/config.js';
import { JOURNAL_DIR } from '../src/chat-journal.js';

const store = new ChatStore();
const chats = store.listChats();
const report = chats.map((key) => ({ chatKey: key, count: store.getChatMeta(key).total }));
console.log(JSON.stringify({ dataDir: DATA_DIR, journalDir: JOURNAL_DIR, chats: report, total: report.reduce((n, c) => n + c.count, 0), legacyJsonRetained: true }, null, 2));
fs.mkdirSync(path.join(DATA_DIR, 'migration-reports'), { recursive: true });
fs.writeFileSync(path.join(DATA_DIR, 'migration-reports', `jsonl-${Date.now()}.json`), JSON.stringify(report, null, 2));
