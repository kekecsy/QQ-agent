export function visionEndpointKey(endpoint) {
  return `${String(endpoint.baseUrl || '').replace(/\/+$/, '')}|${endpoint.model}`;
}

// Normal images can exceed 30s on hosted vision services. GIFs keep their
// existing budget; never inherit the much longer main-chat timeout implicitly.
export function visionTimeoutBudget(cfg = {}, { gif = false } = {}) {
  if (gif) return { perAttemptTimeoutMs: 30000, totalTimeoutMs: 90000 };
  const perAttemptTimeoutMs = Math.max(1000, Math.min(180000, Number(cfg.subagent?.visionTimeoutMs) || 90000));
  const totalTimeoutMs = Math.max(perAttemptTimeoutMs, Math.min(360000, Number(cfg.subagent?.visionTotalTimeoutMs) || 180000));
  return { perAttemptTimeoutMs, totalTimeoutMs };
}

// Bound latency and avoid trying several keys on the same stalled model service.
export async function callVisionWithFallback({ primary, preferred, pick, feedback, call, now = Date.now, perAttemptTimeoutMs = 30000, totalTimeoutMs = 90000 }) {
  const excludeEndpoints = [];
  const excludeAccountIds = [];
  const perAttempt = Math.max(1000, Math.min(180000, Number(perAttemptTimeoutMs) || 30000));
  const deadline = now() + Math.max(1000, Math.min(360000, Number(totalTimeoutMs) || 90000));
  let lastError = new Error('没有可用的视觉渠道');
  for (let attempt = 0; attempt < 3; attempt++) {
    const remaining = deadline - now();
    if (remaining <= 0) break;
    const usePreferred = preferred && attempt === 0;
    const picked = !usePreferred && pick?.({ excludeEndpoints: [...excludeEndpoints], excludeAccountIds: [...excludeAccountIds] });
    const target = usePreferred ? preferred : picked || (!excludeEndpoints.includes(visionEndpointKey(primary)) ? primary : null);
    if (!target) break;
    const key = visionEndpointKey(target);
    if (excludeEndpoints.includes(key)) {
      if (picked) feedback?.({ accountId: picked.id, ok: false, error: '视觉渠道已尝试，释放占位' });
      break;
    }
    excludeEndpoints.push(key);
    if (picked) excludeAccountIds.push(picked.id);
    const startedAt = now();
    try {
      const result = await call(target, Math.min(perAttempt, remaining));
      if (!String(result?.message?.content || '').trim()) throw new Error('视觉模型未返回内容');
      if (picked) feedback?.({ accountId: picked.id, ok: true, latencyMs: now() - startedAt });
      return result;
    } catch (error) {
      lastError = error;
      if (picked) feedback?.({ accountId: picked.id, ok: false, error: String(error.message) });
    }
  }
  throw lastError;
}
