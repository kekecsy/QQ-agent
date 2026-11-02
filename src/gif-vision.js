import { resolveApiKey } from './llm.js';

export const GIF_VISION_MODEL = 'z-ai/glm-5.3-flash-free';

export function gifVisionEndpoint(cfg) {
  const provider = (cfg.providers || []).find((p) => {
    try { const url = new URL(p.baseURL); return url.protocol === 'https:' && url.hostname === 'api.orcarouter.ai'; }
    catch { return false; }
  });
  if (!provider) return null;
  const apiKey = resolveApiKey({ ...cfg, api: { provider: provider.id, apiKey: '' } });
  if (!apiKey) return null;
  return { ...cfg.api, provider: provider.id, baseUrl: provider.baseURL, apiKey, model: GIF_VISION_MODEL };
}
