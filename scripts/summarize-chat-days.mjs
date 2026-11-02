import { ChatStore } from '../src/store.js';
import { summarizeDay } from '../src/daily-history.js';
import { chinaDate } from '../src/chat-journal.js';
import { visibleMessages } from '../src/history-policy.js';
import { getConfig } from '../src/config.js';
import { skillManager } from '../src/skills/manager.js';
import * as accountPool from '../skills/account-pool/index.js';

const store = new ChatStore();
const cfg = getConfig();
accountPool.setup({ config: () => getConfig().skills?.['account-pool'] || {}, log: () => {} });
skillManager.register({ manifest: { id: 'account-pool', enabledByDefault: true, capabilities: ['llm.endpoint-pick', 'llm.endpoint-feedback'] }, providers: accountPool.providers, hooks: {}, available: accountPool.available });
const allowed = new Set([...(cfg.allow?.groups || []).filter((id) => !(cfg.deny?.groups || []).map(String).includes(String(id))).map((id) => `group:${id}`), ...(cfg.allow?.private || []).filter((id) => !(cfg.deny?.private || []).map(String).includes(String(id))).map((id) => `private:${id}`)]);
for (const key of store.listChats().filter((key) => allowed.has(key))) {
  const messages = visibleMessages(key, store.recent(key, { limit: Number.MAX_SAFE_INTEGER }));
  for (const date of [...new Set(messages.map((m) => chinaDate(m.ts)))].sort()) {
    const count = messages.filter((m) => chinaDate(m.ts) === date).length;
    let covered = 0;
    while (covered < count) {
      const saved = await summarizeDay(key, date, messages, { force: true, onError: (e) => console.log(`${key} ${date}: ${String(e.message).replace(/(?:sk-|nvapi-|rc-)[A-Za-z0-9_-]+/g, '[REDACTED]').slice(0, 250)}`) });
      if (!saved || saved.sources.length <= covered) { console.log(`${key} ${date}: 摘要未完成，原文已保留`); break; }
      covered = saved.sources.length;
    }
    console.log(`${key} ${date}: ${covered}/${count} 条已概括`);
  }
}
