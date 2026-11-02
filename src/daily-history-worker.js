import { getConfig } from './config.js';
import { chinaDate } from './chat-journal.js';
import { summarizeDay, validDailySummary } from './daily-history.js';
import { visibleMessages } from './history-policy.js';

export function startDailyHistoryWorker(store, log = () => {}) {
  let stopped = false;
  let running = null;
  const run = () => {
    if (running || stopped || getConfig().store?.historySummary?.enabled !== true) return;
    running = (async () => {
      const cfg = getConfig();
      const allowed = new Set([...(cfg.allow?.groups || []).filter((id) => !(cfg.deny?.groups || []).map(String).includes(String(id))).map((id) => `group:${id}`), ...(cfg.allow?.private || []).filter((id) => !(cfg.deny?.private || []).map(String).includes(String(id))).map((id) => `private:${id}`)]);
      let budget = 3;
      for (const key of store.listChats().filter((key) => allowed.has(key))) {
        const readCurrent = () => store.recent(key, { limit: Number.MAX_SAFE_INTEGER });
        const messages = visibleMessages(key, readCurrent());
        const dates = [...new Set(messages.map((m) => chinaDate(m.ts)))].filter((date) => date < chinaDate()).sort().reverse();
        for (const date of dates) {
          if (stopped || budget <= 0) return;
          const count = messages.filter((m) => chinaDate(m.ts) === date).length;
          const saved = validDailySummary(key, date, messages);
          if (saved && saved.sources.length >= count) continue;
          budget--;
          const summary = await summarizeDay(key, date, messages, { force: true, readCurrent });
          if (summary) log(`[daily-history] ${key} ${date} 已概括 ${summary.sources.length}/${count} 条`);
        }
      }
    })().catch((e) => log(`[daily-history] 摘要后台任务失败：${e.message}`)).finally(() => { running = null; });
  };
  const initial = setTimeout(run, 60000);
  const interval = setInterval(run, 10 * 60000);
  initial.unref?.(); interval.unref?.();
  return async () => { stopped = true; clearTimeout(initial); clearInterval(interval); if (running) await running; };
}
