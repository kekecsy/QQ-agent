import { visibleMessages } from './history-policy.js';
import { listSendFailures } from './send-failures.js';

export function recoveryCandidates(store, chatKey, now = Date.now()) {
  const failures = listSendFailures(chatKey, now);
  return visibleMessages(chatKey, store.recent(chatKey, { limit: Number.MAX_SAFE_INTEGER }))
    .filter((m) => !m.self && m.mid != null && m.ts >= now - 12 * 3600000 && m.ts <= now)
    .filter((m) => m.recovery?.visionFailed || failures.some((f) => f.sourceMids.includes(String(m.mid))) || (!m.visualSummary && m.media?.some((x) => x.kind === 'image')))
    .sort((a, b) => Number(!!(b.recovery?.visionFailed || b.recovery?.sendFailed)) - Number(!!(a.recovery?.visionFailed || a.recovery?.sendFailed)) || b.ts - a.ts)
    .slice(0, 3);
}
