import { getConfig } from './config.js';
import { dailyContext } from './daily-history.js';

export async function compactHistory(chatKey, messages, options = {}) {
  if (getConfig().store?.historySummary?.enabled !== true) return null;
  return dailyContext(chatKey, messages, Date.now(), options);
}
