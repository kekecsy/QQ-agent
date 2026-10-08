// 账号池路由：多端点/多 Key 的负载均衡。
//
// ── 解决什么问题 ──────────────────────────────────────────────────────
// 有人手上有好几把免费 API Key（同一网关多把，或不同网关），速度参差不齐。
// 本 Skill 在每次请求时按权重挑一个端点：权重由**实测延迟**的 EWMA 动态调整 ——
// 快的多接活，慢的少接活；被限流（429）的临时冷却，冷却后自动恢复。
// 不需要人肉盯着切换。
//
// 同款免费 Key 更推荐 `round-robin`：免费额度按 Key 计（如 NVIDIA 40 RPM/Key），
// 均匀摊开最不容易把某一把撞到上限；`weighted` 会把最快的推到限流再冷却，来回抖。
//
// ── 为什么是 Skill ────────────────────────────────────────────────────
// 大多数用户只有一个端点，用不上它；而且"怎么分配"是策略问题，不是核心能力。
// 关掉它就是纯粹的单端点行为，和没有这个功能时完全一致。
//
// ── 数据分两层（刻意的）───────────────────────────────────────────────
//   持久层：Skill 配置里的 accounts[]（用户可编辑：增删改、启停）
//           + 可选的外部端点文件（endpointsFile，见下）
//   运行时：内存 Map（延迟 EWMA / 错误数 / 权重 / 最近使用）**不落盘**
// 不落盘的原因：这些是秒级波动的观测值，写进配置文件既增加写盘频率，
// 又会在重启后留下过期的"快照"误导判断。重启后权重归零重新学习更干净。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

let cfg = () => ({});
let log = () => {};

// accountId -> { latencyEWMA, errorCount, weight, lastUsed, lastUsedSeq, lastErrorAt, totalCalls, rateLimited }
const runtime = new Map();

// 轮转用的单调派发序号。**不能用时间戳**：同一毫秒内的多次挑选时间戳相等，
// 相等时 reduce 会一直停在数组第一个 —— 两把 Key 的池子会退化成"只用第一把"
// （测试抓到的真 bug）。序号在**派发那一刻**就写上，不等 feedback，
// 这样并发在飞的两个请求也不会挑到同一个账号。
let pickSeq = 0;

// ── 两个账号来源 ────────────────────────────────────────────────────────
// ① 手工账号：cfg().accounts[]（可增删改、可启停、可走 UI）
// ② 外部端点文件：cfg().endpointsFile 指向的 JSON
//
// 为什么要有 ②：同一批 Key 往往已经在别的工具里维护着了（例如"打标跑批"用的
// endpoints.nvidia.json）。让账号池直接读那个文件，加一把 Key 只需要改文件
// —— 不用在两处各维护一份，也不会出现"文件里有 4 把、QQ Agent 里只有 3 把"。
//
// 兼容两种形状（实测两种都在用）：
//   ① { endpoints: [{ name, url|baseUrl, model, key, key_env, source, weight, enabled }] }
//   ② { keys: [{ index, key, key_env, source }], api_base | chat_completions_url, model }
//
// ⚠️ 刻意**不采纳**文件里的 extra_body（response_format=json_object、temperature=0
//    之类）：那是给"结构化打标"调的形状，搬到聊天主路径会让回复变成 JSON 或风格僵硬。
//    思考开关同样由 QQ Agent 自己的 thinking 配置管（src/thinking.js 的 nvidia 方言），
//    不读文件里的 chat_template_kwargs。

function configAccounts() {
  const list = cfg().accounts;
  return Array.isArray(list) ? list : [];
}

/** `~` 展开。配置文件里写 ~/xxx.key 是很自然的事，但 fs 不认。 */
function expandHome(p) {
  const s = String(p || '').trim();
  if (!s) return '';
  if (s === '~') return os.homedir();
  if (s.startsWith('~/') || s.startsWith('~\\')) return path.join(os.homedir(), s.slice(2));
  return s;
}

/**
 * 完整 URL → Base URL。
 * llm.js 用 `joinUrl(baseUrl, '/chat/completions')` 拼请求（src/llm.js:373），
 * 所以文件里的 `https://…/v1/chat/completions` 必须归一成 `https://…/v1`，
 * 否则会拼成 `…/v1/chat/completions/chat/completions`。
 */
function toBaseUrl(raw) {
  return String(raw || '').trim()
    .replace(/\/+$/, '')
    .replace(/\/chat\/completions$/i, '')
    .replace(/\/+$/, '');
}

/**
 * Key 解析，按"越具体越优先"：明文 key → key_env 环境变量 → source 文件。
 * 三级都拿不到就返回 missing 原因（该账号会**排除出池**并在快照里显示原因）。
 *
 * ⚠️ 绝不能"拿不到就复用主 Key"：那样看着在均衡，其实三把全撞同一个限额，
 *    是最难发现的一类失效 —— 所以宁可明确标记为不可用。
 */
function resolveKey(entry) {
  const inline = String(entry.key ?? '').trim();
  if (inline) return { key: inline, from: 'inline' };

  const envName = String(entry.key_env ?? entry.keyEnv ?? '').trim();
  const envVal = envName ? String(process.env[envName] ?? '').trim() : '';
  if (envVal) return { key: envVal, from: `env:${envName}` };

  const src = expandHome(entry.source);
  if (src) {
    try {
      const text = fs.readFileSync(src, 'utf8').trim();
      let v = '';
      if (text.startsWith('{')) {
        // 也接受 JSON 形态的 key 文件（{"key":"…"} / {"api_key":"…"}）
        const j = JSON.parse(text);
        v = String(j.key ?? j.api_key ?? j.apiKey ?? j.value ?? '').trim();
      } else {
        // 纯文本：取第一行（避免文件末尾的换行/注释混进来）
        v = (text.split(/\r?\n/)[0] || '').trim();
      }
      if (v) return { key: v, from: `file:${src}` };
      return { key: '', from: '', missing: `源文件里没有 Key：${src}` };
    } catch {
      return { key: '', from: '', missing: `源文件读不到：${src}` };
    }
  }
  return {
    key: '',
    from: '',
    missing: envName ? `环境变量 ${envName} 未设置` : '既没有 key 也没有 key_env'
  };
}

/** 外部端点文件 → 统一账号形状。不认识的内容记进 problems，不抛错。 */
function parseEndpointFile(raw) {
  const problems = [];
  const out = [];

  const push = (index, label, url, model, entry) => {
    const baseUrl = toBaseUrl(url);
    if (!baseUrl) {
      problems.push(`第 ${index + 1} 项「${label}」没有 url/baseUrl，已跳过`);
      return;
    }
    const r = resolveKey(entry || {});
    out.push({
      id: 'file:' + label,
      name: label,
      baseUrl,
      model: String(model || '').trim(),
      key: r.key,
      keyFrom: r.from,
      missingKey: r.key ? '' : (r.missing || '未提供 Key'),
      enabled: (entry || {}).enabled !== false,
      source: 'file',
      weight: Number((entry || {}).weight) || 1
    });
  };

  if (Array.isArray(raw?.endpoints) && raw.endpoints.length) {
    raw.endpoints.forEach((e, i) => {
      if (!e || typeof e !== 'object') { problems.push(`endpoints[${i}] 不是对象，已跳过`); return; }
      push(i, String(e.name || e.id || `endpoint${i + 1}`), e.url || e.baseUrl, e.model, e);
    });
  } else if (Array.isArray(raw?.keys) && raw.keys.length) {
    const baseUrl = raw.chat_completions_url || raw.api_base || raw.baseUrl || '';
    if (!toBaseUrl(baseUrl)) problems.push('keys[] 形状缺少 api_base / chat_completions_url');
    raw.keys.forEach((k, i) => {
      if (!k || typeof k !== 'object') { problems.push(`keys[${i}] 不是对象，已跳过`); return; }
      push(i, String(k.name || k.label || `key${k.index ?? i + 1}`), baseUrl, raw.model, k);
    });
  } else {
    problems.push('文件里既没有 endpoints[] 也没有 keys[]');
  }
  return { accounts: out, problems };
}

// 文件读取带 mtime+size 缓存：路由函数每次请求都会调 allAccounts()，
// 不能每次都读盘 + JSON.parse。改了文件（mtime 变）自然就重新加载。
let fileCache = { sig: '', path: '', accounts: [], problems: [] };

function endpointFileState() {
  const raw = String(cfg().endpointsFile || '').trim();
  if (!raw) return { path: '', accounts: [], problems: [] };

  const filePath = path.isAbsolute(raw) ? raw : path.resolve(process.cwd(), expandHome(raw));
  let sig;
  try {
    const st = fs.statSync(filePath);
    sig = `${filePath}|${st.mtimeMs}|${st.size}`;
  } catch {
    if (fileCache.sig !== `${filePath}|missing`) {
      fileCache = { sig: `${filePath}|missing`, path: filePath, accounts: [], problems: [`端点文件不存在：${filePath}`] };
      log('端点文件读不到：%s（账号池只用配置里的账号）', filePath);
    }
    return fileCache;
  }
  if (fileCache.sig === sig) return fileCache;

  try {
    const parsed = parseEndpointFile(JSON.parse(fs.readFileSync(filePath, 'utf8')));
    const withKey = parsed.accounts.filter((a) => a.key).length;
    fileCache = { sig, path: filePath, accounts: parsed.accounts, problems: parsed.problems };
    log('端点文件已加载：%s → %d 个端点，%d 个有 Key%s',
      filePath, parsed.accounts.length, withKey,
      parsed.problems.length ? `；问题：${parsed.problems.join('；')}` : '');
  } catch (error) {
    fileCache = { sig, path: filePath, accounts: [], problems: [`端点文件解析失败：${error.message}`] };
    log('端点文件解析失败：%s → %s', filePath, error.message);
  }
  return fileCache;
}

/** 合并两个来源。同 (baseUrl, key) 视为同一个账号，避免同一把 Key 被算两次。 */
function allAccounts() {
  const seen = new Set();
  const out = [];
  for (const a of configAccounts()) {
    const k = String(a.key || '').trim();
    if (k) seen.add(`${toBaseUrl(a.baseUrl)}|${k}`);
    out.push({ ...a, source: a.source === 'file' ? 'file' : 'config' });
  }
  for (const a of endpointFileState().accounts) {
    if (a.key && seen.has(`${a.baseUrl}|${a.key}`)) continue;
    if (a.key) seen.add(`${a.baseUrl}|${a.key}`);
    out.push(a);
  }
  return out;
}

/** 合并持久账号 + 内存统计，返回给路由/UI 用的视图（key 可脱敏）。 */
function accountView(a, maskKey = true) {
  const r = runtime.get(a.id) || {};
  const cooldownMs = Number(cfg().cooldownMs) || 60000;
  const lastErrorAt = r.lastErrorAt || 0;
  const baseUrl = String(a.baseUrl || '');
  // 只有"限流类错误"才进入冷却；其它错误（超时、4xx、5xx）只降权，不冷却。
  const rateLimited = !!r.rateLimited;
  const missingKey = String(a.missingKey || '');
  return {
    id: a.id,
    name: String(a.name || ''),
    baseUrl,
    model: String(a.model || ''),
    // 'config' = 手工维护；'file' = 来自外部端点文件（只读）
    source: a.source === 'file' ? 'file' : 'config',
    keyFrom: String(a.keyFrom || (a.key ? 'inline' : '')),
    enabled: a.enabled !== false,
    hasKey: !!a.key,
    key: maskKey ? (a.key ? '******' : '') : String(a.key || ''),
    // 不可用的账号仍留在快照里（附原因），但**不参与挑选** —— 看得到才查得动
    eligible: a.enabled !== false && !!baseUrl && !missingKey,
    reason: missingKey || (!baseUrl ? '缺少 baseUrl' : ''),
    latencyEWMA: Math.round(r.latencyEWMA || 0),
    errorCount: r.errorCount || 0,
    weight: Number(r.weight ?? (Number(a.weight) || 1.0)),
    totalCalls: r.totalCalls || 0,
    lastUsed: r.lastUsed || 0,
    lastUsedSeq: r.lastUsedSeq || 0,
    lastErrorAt,
    coolingDown: rateLimited && cooldownMs > 0 && lastErrorAt > 0 && Date.now() - lastErrorAt < cooldownMs
  };
}

/** 账号池快照（key 脱敏，供 UI/排障）。 */
export function snapshot() {
  const c = cfg();
  const file = endpointFileState();
  const list = allAccounts().map((a) => accountView(a));
  return {
    strategy: ['weighted', 'round-robin', 'fixed'].includes(c.strategy) ? c.strategy : 'weighted',
    weightDecay: Number(c.weightDecay) || 0.05,
    minWeight: Number(c.minWeight) || 0.1,
    cooldownMs: Number(c.cooldownMs) || 60000,
    endpointsFile: String(c.endpointsFile || ''),
    file: {
      path: file.path || '',
      loaded: !!file.path && !file.accounts.length && !file.problems.length ? true : !!file.accounts.length,
      problems: file.problems || []
    },
    counts: {
      total: list.length,
      eligible: list.filter((a) => a.eligible).length,
      fromConfig: list.filter((a) => a.source === 'config').length,
      fromFile: list.filter((a) => a.source === 'file').length
    },
    accounts: list
  };
}

/**
 * 按当前策略挑一个端点。
 * @returns {{ id, baseUrl, apiKey, model } | null}
 *   null = 池空 / 全部不可用 / 全部冷却 —— 调用方回退到自己的配置。
 */
export function pickAccount() {
  const c = cfg();
  const pool = allAccounts()
    .map((a) => accountView(a, false))
    .filter((a) => a.eligible)
    .filter((a) => !a.coolingDown);
  if (!pool.length) return null;

  const strategy = String(c.strategy || 'weighted');
  let chosen;
  if (strategy === 'fixed') {
    chosen = pool[0];
  } else if (strategy === 'round-robin') {
    // 最久没派发的优先 —— 等价于轮流，且不需要维护"池内下标"（池子会随
    // 启停/冷却变化，下标会错位）。排序键是**派发序号**，不是时间戳：
    //   ① 时间戳在同一毫秒内会相等，相等时 reduce 停在数组第一个 → 两把 Key
    //      的池子退化成"只用第一把"（测试抓到过）；
    //   ② 序号在派发时就写（见下），所以并发在飞的两个请求不会挑到同一个。
    // 新账号 seq=0，会被优先选中；失败路径也会回报 feedback，不会卡死。
    chosen = pool.reduce((min, a) => (a.lastUsedSeq < min.lastUsedSeq ? a : min));
    if (chosen) {
      // 派发即占位：不等 feedback，避免并发请求重复挑同一个账号
      runtime.set(chosen.id, { ...(runtime.get(chosen.id) || {}), lastUsedSeq: ++pickSeq });
    }
  } else {
    const minWeight = Number(c.minWeight) || 0.1;
    const weights = pool.map((a) => Math.max(minWeight, Number(a.weight) || 1.0));
    const total = weights.reduce((s, w) => s + w, 0);
    let rand = Math.random() * total;
    let idx = pool.length - 1;
    for (let i = 0; i < pool.length; i++) {
      rand -= weights[i];
      if (rand <= 0) { idx = i; break; }
    }
    chosen = pool[idx];
  }
  if (!chosen) return null;
  return { id: chosen.id, baseUrl: chosen.baseUrl, apiKey: chosen.key, model: chosen.model };
}

/**
 * 记录一次成功请求的延迟，更新 EWMA 与权重。
 * 权重 = 池内平均 EWMA 延迟 / 本账号 EWMA 延迟（越快权重越高），
 * 夹在 [minWeight, 3] 之间防止极端化（某个账号快到把其它全饿死）。
 */
export function recordLatency(accountId, latencyMs) {
  if (!accountId || !Number.isFinite(Number(latencyMs))) return;
  const c = cfg();
  const decay = Number(c.weightDecay) || 0.05;
  const minWeight = Number(c.minWeight) || 0.1;
  const prev = runtime.get(accountId) || {};
  const prevLatency = Number(prev.latencyEWMA) || 0;
  const latencyEWMA = prevLatency === 0
    ? Number(latencyMs)
    : (1 - decay) * prevLatency + decay * Number(latencyMs);

  let avg = 0;
  let n = 0;
  for (const a of allAccounts().filter((x) => x.enabled !== false)) {
    const lat = Number(runtime.get(a.id)?.latencyEWMA || 0);
    if (lat > 0) { avg += lat; n++; }
  }
  avg = n ? avg / n : latencyEWMA;
  const rawWeight = avg > 0 && latencyEWMA > 0 ? avg / latencyEWMA : 1.0;
  const weight = Math.min(3, Math.max(minWeight, rawWeight));

  runtime.set(accountId, {
    ...prev,
    latencyEWMA,
    weight,
    lastUsed: Date.now(),
    totalCalls: (prev.totalCalls || 0) + 1
  });
}

/**
 * 记录一次失败。
 * @param {boolean} isRateLimited 是否限流（429/速率类错误）—— 限流进冷却，其它只降权。
 *
 * ⚠️ 限流标记在冷却窗口内**保持粘性**：429 进入冷却后，几秒后同账号的一次超时/5xx
 * 不能把标记覆写成 false —— 否则 coolingDown 立即失效，冷却中的账号被重新投用，
 * 继续撞 429，陷入"刚冷却就被投用"的循环。窗口自然过期后标记失效，不会永久冷却。
 */
export function recordError(accountId, isRateLimited) {
  if (!accountId) return;
  const c = cfg();
  const minWeight = Number(c.minWeight) || 0.1;
  const cooldownMs = Number(c.cooldownMs) || 60000;
  const now = Date.now();
  const prev = runtime.get(accountId) || {};
  const base = Number(prev.weight ?? 1.0);
  const rateLimited = !!isRateLimited
    || (prev.rateLimited === true && (now - (prev.lastErrorAt || 0)) < cooldownMs);
  runtime.set(accountId, {
    ...prev,
    errorCount: (prev.errorCount || 0) + 1,
    weight: Math.max(minWeight, base * 0.8),
    rateLimited,
    lastErrorAt: now,
    lastUsed: now
  });
}

/** 重置统计（UI 上的"恢复"按钮）。不传 id 则全部重置。 */
export function resetStats(accountId) {
  if (accountId) runtime.delete(accountId);
  else runtime.clear();
}

// ── 账号增删改（只改 Skill 配置命名空间，不碰核心 api 配置，也不动外部文件）──

export function addAccount({ baseUrl, key = '', model = '', name = '' } = {}) {
  const base = String(baseUrl || '').trim();
  if (!base) return { error: 'Base URL 不能为空' };
  const account = {
    id: 'acc_' + crypto.randomBytes(4).toString('hex'),
    name: String(name || '').trim(),
    baseUrl: base,
    key: String(key || '').trim(),
    model: String(model || '').trim(),
    enabled: true
  };
  return { account: accountView(account), accounts: [...configAccounts(), account] };
}

export function updateAccount(id, patch = {}) {
  const list = configAccounts();
  const idx = list.findIndex((a) => a.id === id);
  if (idx < 0) return { error: '账号不存在（外部端点文件里的账号是只读的，请改那个文件）' };
  const next = { ...list[idx] };
  for (const k of ['name', 'baseUrl', 'model']) if (k in patch) next[k] = String(patch[k] ?? '').trim();
  if (typeof patch.enabled === 'boolean') next.enabled = patch.enabled;
  // 留空 = 不换 Key（避免用户在 UI 里没动 Key 却把它清掉）
  if ('key' in patch) {
    const k = String(patch.key ?? '').trim();
    if (k) next.key = k;
  }
  const out = [...list];
  out[idx] = next;
  if (patch.enabled === false) runtime.delete(id);   // 停用即清空统计
  return { account: accountView(next), accounts: out };
}

export function removeAccount(id) {
  runtime.delete(id);
  return { ok: true, accounts: configAccounts().filter((a) => a.id !== id) };
}

// ── Skill 生命周期 ────────────────────────────────────────────────────────

export function setup(api) {
  cfg = api.config;
  log = api.log;
}

export const providers = {
  /** 挑一个端点。核心在"主调用路径"上取用；返回 null 表示回退到自身配置。 */
  'llm.endpoint-pick': () => pickAccount(),

  /** 回报结果，用于动态调权。 */
  'llm.endpoint-feedback': ({ accountId, ok, latencyMs, error, status } = {}) => {
    if (!accountId) return { ok: true };
    if (ok) {
      recordLatency(accountId, latencyMs);
      return { ok: true };
    }
    // 只在明确的限流信号上冷却：429，或错误文本里带 rate limit / 限流 / 配额
    const limited = Number(status) === 429 || /429|rate.?limit|too many requests|限流|配额/i.test(String(error || ''));
    recordError(accountId, limited);
    return { ok: true, cooling: limited };
  },

  /** 快照（UI/排障用）。 */
  'llm.endpoint-snapshot': () => snapshot()
};

/** 有可用账号才算就绪；池子空时 UI 直接显示原因，而不是假装生效。 */
export function available() {
  const list = allAccounts();
  const usable = list.filter((a) => a.enabled !== false && String(a.baseUrl || '').trim() && !a.missingKey);
  if (usable.length) return { ok: true };
  const blocked = list.filter((a) => a.missingKey);
  if (blocked.length) {
    return { ok: false, reason: `${blocked.length} 个账号拿不到 Key（${blocked[0].missingKey}）` };
  }
  const file = endpointFileState();
  if (file.problems?.length) return { ok: false, reason: file.problems[0] };
  return { ok: false, reason: '账号池是空的（至少加一个 Base URL，或配一个端点文件）' };
}

export const internals = {
  snapshot, pickAccount, recordLatency, recordError, resetStats,
  addAccount, updateAccount, removeAccount,
  allAccounts, configAccounts, endpointFileState, parseEndpointFile, resolveKey, toBaseUrl,
  __accountView: accountView
};
