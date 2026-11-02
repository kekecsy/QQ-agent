export function historyMentionDone(entry) {
  return Boolean(entry.historyMentionHandled && (!entry.historyCatchup || entry.historyMentionCompletedAt));
}
export function verifiedMentionFloor(waiting, anchor) {
  if (anchor && Number.isFinite(Number(anchor.ts))) return Number(anchor.ts);
  const catchup = (waiting?.trigger || []).filter((m) => m.historyCatchup);
  if (catchup.length) return Math.min(...catchup.map((m) => Number(m.ts)));
  return waiting?.startedAt ? Number(waiting.startedAt) - 60000 : Infinity;
}
export function selectHistoryMention(messages) {
  const sorted = [...messages].sort((a, b) => a.ts - b.ts || a.id - b.id);
  for (let i = sorted.length - 1; i >= 0; i--) {
    const entry = sorted[i];
    if (!entry.historical || !entry.atMe || entry.self || historyMentionDone(entry)) continue;
    const later = sorted.slice(i + 1);
    if (later.some((m) => m.self || historyMentionDone(m))) return null;
    const chatter = later.filter((m) => !m.self);
    if (chatter.length > 12 || chatter.reduce((n, m) => n + String(m.text || '').length, 0) > 1500) return null;
    return { entry, laterCount: chatter.length };
  }
  return null;
}
