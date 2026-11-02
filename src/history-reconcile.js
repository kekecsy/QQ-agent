// QQ may announce login before its local history cache has finished syncing.
export function createHistoryReconciler(sync, { delays = [0, 20000, 60000, 180000], onError = () => {} } = {}) {
  let generation = 0;
  const timers = new Set();
  let queue = Promise.resolve();
  function cancel() {
    generation++;
    for (const timer of timers) clearTimeout(timer);
    timers.clear();
  }
  function start() {
    cancel();
    const current = generation;
    for (const delay of delays) {
      const timer = setTimeout(() => {
        timers.delete(timer);
        queue = queue.then(async () => {
          if (current !== generation) return;
          try { await sync(); } catch (error) { onError(error); }
        });
      }, delay);
      timer.unref?.();
      timers.add(timer);
    }
  }
  return { start, cancel };
}
