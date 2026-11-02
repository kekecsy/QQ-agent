import { visibleMessages } from './history-policy.js';

export const isIncomingImage = (entry) => !!entry && !entry.self && !entry.historical
  && entry.mid != null && entry.media?.some((m) => m.kind === 'image' && m.url && m.source !== 'share-card-cover');

export function imageReplyTiming(cfg) {
  if (cfg.imageReply?.enabled === false) return null;
  const quiet = Number(cfg.imageReply?.quietMs);
  const cap = Number(cfg.imageReply?.maxWaitMs);
  const quietMs = Number.isFinite(quiet) ? Math.max(0, Math.min(30000, quiet)) : 4000;
  const maxWaitMs = Number.isFinite(cap) ? Math.max(quietMs, Math.min(60000, cap)) : Math.max(quietMs, 12000);
  return { quietMs, maxWaitMs };
}

// Observation only: completion updates facts, never schedules a chat or sends a reply.
export class IncomingImageObserver {
  constructor({ store, analyze, emit = () => {} }) {
    this.store = store;
    this.analyze = analyze;
    this.emit = emit;
    this.jobs = new Map();
    this.queue = [];
    this.active = 0;
  }
  key(chatKey, mid) { return `${chatKey}/${mid}`; }
  isPending(chatKey, mid) { return this.jobs.has(this.key(chatKey, mid)); }
  observe(chatKey, entry) {
    if (!isIncomingImage(entry) || entry.visualSummary || this.isPending(chatKey, entry.mid) || this.jobs.size >= 8) return;
    const job = { chatKey, mid: entry.mid, controller: new AbortController() };
    this.jobs.set(this.key(chatKey, entry.mid), job);
    this.queue.push(job);
    this.drain();
  }
  drain() {
    while (this.active < 2 && this.queue.length) {
      const job = this.queue.shift();
      if (job.controller.signal.aborted) continue;
      this.active++;
      void this.run(job).finally(() => { this.active--; this.drain(); });
    }
  }
  async run(job) {
    const { chatKey, mid, controller } = job;
    try {
      const entry = this.store.findByMid(chatKey, mid);
      if (!entry || !visibleMessages(chatKey, [entry]).length || entry.visualSummary) return;
      const facts = await this.analyze(chatKey, entry, { signal: controller.signal });
      const current = this.store.findByMid(chatKey, mid);
      if (controller.signal.aborted || !facts || !current || !visibleMessages(chatKey, [current]).length || current.visualSummary) return;
      this.store.updateByMid(chatKey, mid, { visualSummary: String(facts).slice(0, 1800), recovery: { visionFailed: false } });
      this.emit('chat-update', chatKey);
    } catch {
      // Background failure is not a demand to retry or reply to the image.
    } finally {
      const key = this.key(chatKey, mid);
      if (this.jobs.get(key) === job) this.jobs.delete(key);
    }
  }
  cancel(chatKey = null) {
    for (const [key, job] of this.jobs) {
      if (chatKey !== null && job.chatKey !== chatKey) continue;
      job.controller.abort();
      this.jobs.delete(key);
    }
    this.queue = this.queue.filter((job) => !job.controller.signal.aborted);
  }
}
