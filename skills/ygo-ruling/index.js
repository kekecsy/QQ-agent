// 游戏王判例助手（ygo-ruling）—— 群里的 OCG 规则 / 判例问答
//
// ── 为什么是技能（skills/，LLM 型），不是插件（plugins/）────────────────────
//   判据：规则能不能写死。能写死、满足条件必然执行 → 插件；要理解人话 → 技能。
//   "这句话问的是哪几张卡""这题要不要翻 Lua 脚本""他的具体场景指哪一种处理"
//   全是语义判断，没有规则可穷举，只能交给模型。所以用 registerTool 把
//   三个取证工具交给模型，由它决定何时查、查到什么程度。
//
// ── 数据源（全部在本机实测过）─────────────────────────────────────────────
//   · 卡面：https://ygocdb.com/api/v0/?search=<关键词>
//       免 Key、免鉴权。支持 中文名 / 中文部分名 / 英文名 / 卡片密码（纯数字），
//       实测 80~450ms 返回。字段：cn_name / id / cid / text.types / text.desc /
//       text.pdesc / faqcount / sc_name / md_name / nwbbs_n / cnocg_n / jp_name / en_name。
//       （README 标注该接口不稳定，所以失败时必须明确告知，不能装作查到了。）
//   · Lua 脚本：ProjectIgnis/CardScripts 仓库的 official / pre-release 目录，
//       文件名 c<密码>.lua。
//       ⚠️ 本机 raw.githubusercontent.com 直连被墙（实测 ~100ms 直接 fetch failed），
//          必须走代理。实测可用： https://gh-proxy.com/ 、 https://ghproxy.net/
//          （都能在 ~1s 内返回真实脚本）。jsDelivr 对这个大仓库直接 403，不要用。
//       ⚠️ 通常怪兽一般没有脚本（实测青眼白龙 c89631139.lua 就是 404）——
//          "取不到"是正常情况，要如实说，不能假装看过脚本。
//
// ── 照 src/plugin-loader.js 的规矩 ────────────────────────────────────────
//   · 工具必须在 setup(api) 执行期间注册；写到别的函数里等于静默失效
//   · 提示词片段必须在模块顶层 export（api 上没有注册提示词的方法）
//   · 缓存一律落在 DATA_DIR/ygo-ruling/ 下，绝不能用 process.cwd() 当锚点
//   · 需要联网必须在 skill.json 里声明 permissions: ["web_fetch"]，否则拿不到 fetch

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DATA_DIR } from '../../src/config.js';
import { syncStatus, startSync, searchLocalCards } from './data-sync.mjs';

export const settingsActions = {
  actions: [{ id: 'cards', label: '同步卡库' }, { id: 'lua', label: '同步 Lua 脚本' }],
  status: () => syncStatus(),
  run: (action, settings) => startSync(action, settings)
};

const SKILL_ID = 'ygo-ruling';
const YGOCDB_API = 'https://ygocdb.com/api/v0/';
const RAW_BASE = 'https://raw.githubusercontent.com/ProjectIgnis/CardScripts/master';

/** 脚本来源，按顺序试：先官方，再 pre-release（与上游工具一致）。 */
const SCRIPT_SOURCES = [
  { key: 'official', path: 'official', label: 'official（官方）', page: 'https://github.com/ProjectIgnis/CardScripts/blob/master/official' },
  { key: 'pre-release', path: 'pre-release', label: 'pre-release（预发布）', page: 'https://github.com/ProjectIgnis/CardScripts/blob/master/pre-release' },
  // 先行卡兜底（2026-10-07）：CardScripts 对先行卡经常双 404（连 pre-release 都没有），
  // 而 ygopro 主线脚本库收录得快 —— 实测西艾萝-一掷乾坤 c73090586 只在这里有。
  // 该库是根路径直挂 c<密码>.lua，所以 base 单独给、path 留空。
  { key: 'ygopro', path: '', base: 'https://raw.githubusercontent.com/Fluorohydride/ygopro-scripts/master', label: 'ygopro-scripts（先行/主线库）', page: 'https://github.com/Fluorohydride/ygopro-scripts' }
];

/** 脚本来源目录页。**故意不提供具体文件 URL** —— 文件名是 `c<密码>.lua`，
 *  直接回给模型就等于把密码泄给它（2026-10-05）。 */
function sourcePageOf(label) {
  return SCRIPT_SOURCES.find((s) => s.label === label)?.page
    || 'https://github.com/ProjectIgnis/CardScripts';
}

const DIR = path.join(DATA_DIR, SKILL_ID);
const CACHE_DIR = path.join(DIR, 'scripts');
/** 全量镜像目录（scripts/sync-ygo-scripts.mjs 落盘，无 TTL；fetchScript 优先读这里）。 */
const MIRROR_DIR = path.join(DIR, 'scripts-mirror');

/** 卡片插图的图床。文件名就是卡片密码：`pics/<密码>.jpg`。
 *  实测（2026-10-05）老卡、新卡、异画共 4 张全部 200 / image/jpeg / 70~90KB。 */
const CARD_IMAGE_BASE = 'https://cdn.233.momobako.com/ygopro/pics/';

/**
 * 由卡片密码拼出插图地址。
 * ⚠️ 这个地址**只在技能内部使用**，绝不放进给模型的任何文本里 ——
 *    文件名是卡片密码，模型看到就会顺口念给用户（见 formatCard 的说明）。
 */
function cardImageUrl(id) {
  return `${CARD_IMAGE_BASE}${String(id).replace(/\D/g, '')}.jpg`;
}

/** 这座机器上 ygocdb 对非浏览器 UA 也正常，但带上 UA 更稳。 */
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

/** 一次 get_card 最多处理几个卡名，避免模型一次塞一大串把一轮拖死。 */
const MAX_BATCH = 12;
/** 脚本返回的硬上限（设置里的 maxScriptChars 只能小于它）。 */
const SCRIPT_HARD_CAP = 40000;
/** get_script 一次最多取几张（脚本很大，防一次塞爆上下文）。 */
const SCRIPT_BATCH_MAX = 5;

let cfg = () => ({});
let log = () => {};

// ── 小工具 ────────────────────────────────────────────────────────────────

function num(v, dflt) {
  const n = Number(v);
  return Number.isFinite(n) ? n : dflt;
}

function clamp(n, lo, hi) {
  return Math.max(lo, Math.min(hi, n));
}

/**
 * 解析代理前缀列表。每一项都是"拼在 raw 地址前面的前缀"，
 * 例如 `https://gh-proxy.com/` → `https://gh-proxy.com/https://raw.githubusercontent.com/...`。
 * 末尾**总是**补一个直连（空前缀）兜底：代理全挂时还有最后一条路。
 */
function proxyPrefixes(configured) {
  const list = String(configured ?? '')
    .split(/[,，\s]+/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => (s.toLowerCase() === 'direct' ? '' : s));
  if (!list.includes('')) list.push('');
  return list;
}

/** 归一名：去掉 @、书名号、引号、空白，转小写 —— 与上游网页工具同一套。 */
function normName(s) {
  return String(s ?? '')
    .trim()
    .replace(/^[@\s]+/, '')
    .replace(/[《》「」“”《》]/g, '')
    .replace(/\s+/g, '')
    .toLowerCase();
}

/** 一张卡的全部可匹配名字（含密码 / cid）。 */
function cardAliases(card) {
  return [card.cn_name, card.sc_name, card.md_name, card.nwbbs_n, card.cnocg_n, card.jp_name, card.en_name, card.id, card.cid]
    .filter(Boolean)
    .map(String);
}

/**
 * 匹配打分：**任一别名**与搜索词完全相等 = 100，候选名包含搜索词 = 60，搜索词包含候选名 = 20。
 * 必须把所有别名都算进去 —— 实测「黑魔导」查的是「黑魔术师」（命中民间译名别名），
 * 只看 cn_name 会算成 0 分，把一张完全确定的卡误判成"歧义"。
 * 同时回报命中的是哪个别名：候选清单里要显示它，用户才认得出自己说的是哪张。
 */
function scoreCard(card, token) {
  const target = normName(token);
  if (!target) return { score: 0, alias: '', onPrimary: false, exactWord: false };
  // 主名（中文名 / 简中 / MD）—— 仅在**同分**时参与排序，不改变 score 语义。
  const primary = new Set([card.cn_name, card.sc_name, card.md_name].filter(Boolean).map(normName));
  let best = 0;
  let alias = '';
  let onPrimary = false;
  let exactWord = false;
  for (const candidate of cardAliases(card)) {
    const n = normName(candidate);
    if (!n) continue;
    const s = n === target ? 100 : n.includes(target) ? 60 : target.includes(n) ? 20 : 0;
    if (!s) continue;
    // 「整词命中」：查询词是候选名里**独立的一段**（卡名惯用空格分词）。
    // 实测（2026-10-05）查「霍普」：「No.39 希望皇 霍普」里「霍普」自成一段 ✅，
    // 而「剑斗兽 霍普洛姆斯」（简中名）里只是半个词 ❌ —— 两者同为 60 分，
    // 只能靠这一条把用户真正想说的那张排到前面。
    const word = String(candidate).split(/[\s·・]+/).some((w) => normName(w) === target);
    const prim = primary.has(n);
    const cur = [s, word ? 1 : 0, prim ? 1 : 0];
    const curBest = [best, exactWord ? 1 : 0, onPrimary ? 1 : 0];
    if (cur[0] > curBest[0]
      || (cur[0] === curBest[0] && (cur[1] > curBest[1] || (cur[1] === curBest[1] && cur[2] > curBest[2])))) {
      best = s; alias = String(candidate); onPrimary = prim; exactWord = word;
    }
  }
  return { score: best, alias, onPrimary, exactWord };
}

/** 取打分最高的一张；同分时 整词命中 > 主名命中 > 卡库顺序（见 scoreCard）。 */
function pickBest(cards, token) {
  let best = cards[0] ?? null;
  let bestScore = -1;
  let bestTie = [-1, -1];   // [exactWord, onPrimary]
  for (const card of cards) {
    const { score, onPrimary, exactWord } = scoreCard(card, token);
    const tie = [exactWord ? 1 : 0, onPrimary ? 1 : 0];
    if (score > bestScore
      || (score === bestScore && (tie[0] > bestTie[0] || (tie[0] === bestTie[0] && tie[1] > bestTie[1])))) {
      best = card;
      bestScore = score;
      bestTie = tie;
    }
  }
  return { card: best, score: Math.max(bestScore, 0) };
}

/**
 * 去掉中文虚词得到"核心词"，只在结果可疑地少时用来补搜一次。
 * 实测：「真红眼的黑龙」只会命中「真红眼黑龙剑」，去掉「的」补搜「真红眼黑龙」才对。
 * ⚠️ 只对含中文的查询做这件事 —— 对英文名去掉空格（"Ash Blossom" → "AshBlossom"）
 * 会搜出完全无关的乱码记录，反而比原词更糟。返回空串 = 不要补搜。
 */
function coreKeyword(s) {
  const str = String(s ?? '');
  if (!/[\u3400-\u9fff]/.test(str)) return '';
  return str.replace(/[的之·・「」《》‘’“”]/g, '').trim();
}

/** 把 ygocdb 的原始记录压成我们要的形状（对齐上游 normalizeCard，只留有用的）。 */
function normalizeCard(raw) {
  const text = raw?.text || {};
  return {
    id: raw?.id !== undefined && raw?.id !== null ? String(raw.id) : '',
    cid: raw?.cid !== undefined && raw?.cid !== null ? String(raw.cid) : '',
    cn_name: raw?.cn_name || text?.name || raw?.sc_name || raw?.md_name || '',
    sc_name: raw?.sc_name || '',
    md_name: raw?.md_name || '',
    nwbbs_n: raw?.nwbbs_n || '',
    cnocg_n: raw?.cnocg_n || '',
    jp_name: raw?.jp_name || '',
    en_name: raw?.en_name || '',
    types: text?.types || '',
    pdesc: text?.pdesc || '',
    desc: text?.desc || '',
    faqcount: raw?.faqcount ?? ''
  };
}

/**
 * 一张卡 → 给模型看的文本块。
 *
 * ⚠️ **不输出卡片密码 / cid**（2026-10-05 用户要求）。
 *   密码（card.id）与 cid 是内部标识，模型看到就会顺口念给用户（实测「简中叫神鹰羽毛扫，
 *   密码18144506」这种第三条废话），所以整条链路里**对模型一律不暴露**：
 *     · 这里不显示；
 *     · 候选清单 formatCandidate 也不显示；
 *     · get_script 因此改成"可传卡名"，自己内部把密码解出来（见该工具）；
 *     · get_script 里连 URL / 文件名 `c<密码>.lua` 都要脱敏，只给来源目录页。
 *   密码仍然是内部主键：脚本缓存文件名、get_script 抓取都靠它，只是不给模型看。
 */
function formatCard(card, { includeFaq = true, index = null } = {}) {
  const head = `${index !== null ? `${index}. ` : ''}【${card.cn_name || '（无名）'}】`;
  const alias = [
    card.jp_name && `日文：${card.jp_name}`,
    card.en_name && `英文：${card.en_name}`,
    card.sc_name && card.sc_name !== card.cn_name && `简中：${card.sc_name}`,
    card.md_name && card.md_name !== card.cn_name && `MD：${card.md_name}`,
    card.nwbbs_n && card.nwbbs_n !== card.cn_name && `民翻：${card.nwbbs_n}`,
    card.cnocg_n && card.cnocg_n !== card.cn_name && `CNOCG：${card.cnocg_n}`
  ]
    .filter(Boolean)
    .join(' / ');

  const lines = [head];
  if (alias) lines.push(`别名：${alias}`);
  if (card.types) lines.push(`类型：${card.types.replace(/\s*\n\s*/g, ' ').trim()}`);
  if (card.pdesc) lines.push(`灵摆效果：${card.pdesc}`);
  lines.push(`效果文本：${card.desc || '（这张卡没有效果文本）'}`);
  if (includeFaq && card.faqcount !== '' && card.faqcount !== undefined) {
    lines.push(`官方FAQ条目数：${card.faqcount}${Number(card.faqcount) > 0 ? '（有官方问答资料，可提示去查）' : ''}`);
  }
  return lines.join('\n');
}

/**
 * 一张卡 → 候选清单里的一行。**故意不带效果文本**：候选多时（实测「龙」有 100 条）
 * 全塞全文会把上下文撑爆，而且对"认出是哪张"毫无帮助。
 * 一行里给足识别信息：名称 / 类型 / FAQ 量 / 命中的别名。
 * ⚠️ 不显示密码（见 formatCard 的说明）—— 模型要取全文就用**名称**调 get_card。
 */
function formatCandidate(entry, index) {
  const { card, alias } = entry;
  const types = String(card.types || '').replace(/\s*\n\s*/g, ' ').trim();
  const parts = [`${index}. ${card.cn_name || '（无名）'}`];
  if (types) parts.push(types);
  if (card.faqcount !== '' && card.faqcount !== undefined) parts.push(`FAQ ${card.faqcount}`);
  let line = parts.join(' ｜ ');
  if (alias && normName(alias) !== normName(card.cn_name)) line += ` ｜别名「${alias}」`;
  return line;
}

function buildCandidateList(entries, limit) {
  return entries.slice(0, limit).map((entry, i) => formatCandidate(entry, i + 1)).join('\n');
}

// ── 联网 ──────────────────────────────────────────────────────────────────

async function fetchJson(url, timeoutMs) {
  const res = await fetch(url, {
    headers: { 'user-agent': UA, accept: 'application/json,text/plain,*/*' },
    signal: AbortSignal.timeout(timeoutMs),
    redirect: 'follow'
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

/** 查卡库。返回归一化后的数组（可能为空）。 */
async function searchYgocdb(keyword, timeoutMs) {
  const url = `${YGOCDB_API}?search=${encodeURIComponent(keyword)}`;
  let data;
  try { data = await fetchJson(url, timeoutMs); }
  catch (error) {
    const local = searchLocalCards(keyword);
    if (!local.length) throw error;
    return local.map(normalizeCard);
  }
  const list = Array.isArray(data?.result) ? data.result : (Array.isArray(data) ? data : []);
  // 卡库偶尔会回"空壳记录"（没有名称、密码 0）——实测搜英文名时出现过，
  // 留着会让模型把一张不存在的卡当候选，直接丢掉。
  return list.map(normalizeCard).filter((c) => c.cn_name || (c.id && c.id !== '0'));
}

function scriptCachePath(id) {
  return path.join(CACHE_DIR, `c${id}.lua`);
}
function scriptMetaPath(id) {
  return path.join(CACHE_DIR, `c${id}.json`);
}

/** 读本地镜像：按 SCRIPT_SOURCES 优先级找 c<id>.lua，命中即离线可用（无 TTL）。
 *  返回 { code, source, url: '' } 或 null（「本地镜像」标记由输出层统一追加，此处不重复带）。 */
function readMirror(id) {
  const file = `c${id}.lua`;
  for (const s of SCRIPT_SOURCES) {
    try {
      const code = fs.readFileSync(path.join(MIRROR_DIR, s.key, file), 'utf8');
      if (code) return { code, source: s.label, url: '' };
    } catch { /* 未命中换下一个源 */ }
  }
  return null;
}

function readCache(id, ttlHours) {
  if (!(ttlHours > 0)) return null;
  try {
    const meta = JSON.parse(fs.readFileSync(scriptMetaPath(id), 'utf8'));
    const code = fs.readFileSync(scriptCachePath(id), 'utf8');
    if (!code) return null;
    const age = Date.now() - Date.parse(meta?.fetchedAt || 0);
    if (!Number.isFinite(age) || age > ttlHours * 3600 * 1000) return null;
    return { code, source: meta?.source || '', url: meta?.url || '' };
  } catch {
    return null;
  }
}

function writeCache(id, payload) {
  try {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    const tmp = `${scriptCachePath(id)}.tmp`;
    fs.writeFileSync(tmp, payload.code, 'utf8');
    fs.renameSync(tmp, scriptCachePath(id));
    fs.writeFileSync(
      scriptMetaPath(id),
      JSON.stringify({ fetchedAt: new Date().toISOString(), source: payload.source, url: payload.url }),
      'utf8'
    );
  } catch (error) {
    log('写脚本缓存失败（不影响本次返回）：%s', error?.message ?? error);
  }
}

/** 判断响应体是不是脚本（而不是代理返回的 HTML/错误页）。 */
function looksLikeLua(text) {
  const head = String(text || '').slice(0, 400);
  if (/^\s*</.test(head)) return false;               // HTML
  if (/not\s*found/i.test(head) && head.length < 200) return false;
  return /GetID\s*\(|initial_effect|^\s*--/m.test(String(text || '')) || String(text || '').length > 200;
}

/**
 * 取 Lua 脚本。按 来源×代理 的组合依次尝试。
 * @returns {{found:true, code, source, url, fromCache?}|{found:false, tried:string[]}}
 */
async function fetchScript(cardId, options) {
  // ① 本地镜像（sync 脚本全量落盘，无 TTL、零网络）——永远最先查
  const mirrored = readMirror(cardId);
  if (mirrored) return { found: true, ...mirrored, fromMirror: true };
  const cached = readCache(cardId, options.cacheHours);
  if (cached) return { found: true, ...cached, fromCache: true };

  const file = `c${cardId}.lua`;
  const tried = [];
  for (const source of SCRIPT_SOURCES) {
    for (const prefix of options.prefixes) {
      const url = `${prefix}${source.base ?? RAW_BASE}/${source.path ? source.path + "/" : ""}${file}`;
      tried.push(url);
      try {
        const res = await fetch(url, {
          headers: { 'user-agent': UA, accept: 'text/plain,*/*' },
          signal: AbortSignal.timeout(options.timeoutMs),
          redirect: 'follow'
        });
        if (!res.ok) continue;
        const code = await res.text();
        if (!looksLikeLua(code)) continue;
        const payload = { code, source: source.label, url };
        writeCache(cardId, payload);
        return { found: true, ...payload };
      } catch {
        // 单个组合失败就试下一个；全部失败时才判定"取不到"
      }
    }
  }
  return { found: false, tried };
}

// ── 工具 ──────────────────────────────────────────────────────────────────

export function setup(api) {
  cfg = api.config;
  log = api.log;

  // ① 搜索卡片 —— 智能模式：能确定就直给全文，不能确定就只给候选清单
  api.registerTool({
    id: 'search_card',
    name: '搜索游戏王卡片',
    description: '按卡名 / 别名 / 英文名 / 卡片密码（数字）搜索游戏王卡片。默认 detail=auto：卡库能确定是哪张时直接返回完整卡面；结果有多个易混候选时（或结果太多）**只返回不带效果文本的候选清单**，由你自己判断选哪张、或者把清单发给用户让他挑。回答规则或判例问题前先用它把卡文查证清楚，不要凭记忆复述卡片文本。',
    category: 'knowledge',
    icon: '🃏',
    parameters: {
      type: 'object',
      properties: {
        keyword: { type: 'string', description: '搜索词：中文卡名（可以只写一部分）、日文/英文名，或卡片密码（一串数字）' },
        detail: {
          type: 'string',
          enum: ['auto', 'list', 'full'],
          description: 'auto（默认）=能确定就给全文、不确定就给候选清单；list=强制只给候选清单（想要精简列表时用）；full=强制把前几张的完整卡面都返回'
        },
        limit: { type: 'number', description: 'detail=full 时最多返回几张完整卡面，默认取设置里的条数' }
      },
      required: ['keyword']
    },
    async execute(_ctx, args) {
      const keyword = String(args?.keyword ?? '').trim();
      if (!keyword) return { content: '错误：请给出搜索词（卡名或密码）', isError: true };

      const conf = cfg() || {};
      const timeout = num(conf.timeoutMs, 15000);
      const detail = ['auto', 'list', 'full'].includes(String(args?.detail ?? '')) ? String(args.detail) : 'auto';
      const limit = clamp(num(args?.limit, num(conf.maxResults, 5)), 1, 20);
      const candLimit = clamp(num(conf.maxCandidates, 8), 3, 20);
      const useFaq = conf.includeFaqHint !== false;

      let cards = [];
      // effective = 真正用来判定的搜索词。补搜成功后就换成核心词 ——
      // 否则会按原词打分（「真红眼的黑龙」谁都对不上），把已经精确命中的结果误判成"歧义"。
      let effective = keyword;
      let retriedWith = '';
      try {
        cards = await searchYgocdb(keyword, timeout);
        // 结果可疑地少（0 条，或只有 1~2 条且没有完全同名的）时，用"核心词"补搜一次。
        const core = coreKeyword(keyword);
        const suspicious = !cards.length
          || (cards.length <= 2 && !cards.some((c) => scoreCard(c, keyword).score >= 100));
        if (suspicious && core && normName(core) !== normName(keyword)) {
          const again = await searchYgocdb(core, timeout);
          // ⚠️ 补搜结果必须**确实更准**才采用：有完全同名的卡，或原本一条都没有、
          // 而补搜至少有一条沾边的（分数 > 0）。卡库对乱码/不存在的词也会硬吐一张卡，
          // 不设这个门槛就会把"没这张卡"答成一张完全无关的卡。
          const usable = again.some((c) => scoreCard(c, core).score >= 100)
            || (!cards.length && again.some((c) => scoreCard(c, core).score > 0));
          if (usable) {
            cards = again;
            effective = core;
            retriedWith = core;
          }
        }
      } catch (error) {
        return { content: `搜索失败：${error?.message ?? error}。卡库（ygocdb）可能暂时不可用，稍后再试；不要凭印象编造卡文。`, isError: true };
      }

      if (!cards.length) {
        return {
          content: `没搜到「${keyword}」。卡库支持：中文全名 / 中文部分名 / 日文名 / 英文名 / 卡片密码（8 位数字）。\n换个写法再试一次：去掉「的」之类的虚词只留核心词、写全名，或者直接给密码。「没搜到」不等于这张卡不存在，也可能只是卡库这会儿查不到 —— 别凭印象编造卡文。`
        };
      }

      const scored = cards.map((card) => ({ card, ...scoreCard(card, effective) }));
      const exact = scored.filter((x) => x.score >= 100);
      const notes = [];
      if (retriedWith) notes.push(`原词「${keyword}」匹配不佳，已按核心词「${retriedWith}」补搜`);
      if (cards.length >= 100) notes.push('已达卡库单次返回上限 100 条，实际可能更多');
      const note = notes.length ? `\n（${notes.join('；')}）` : '';

      // ── detail=full：老行为，前 limit 张全文 ──
      if (detail === 'full') {
        const top = scored.slice(0, limit);
        const body = top.map((x, i) => formatCard(x.card, { includeFaq: useFaq, index: i + 1 })).join('\n\n');
        const more = cards.length > top.length ? `\n\n（共 ${cards.length} 条，只列了前 ${top.length} 条）` : '';
        return { content: `「${keyword}」搜到 ${cards.length} 张${note}\n\n${body}${more}` };
      }

      // ── 只有一条结果：卡库已经替你挑好了，直接给全文 ──
      if (cards.length === 1) {
        const only = scored[0];
        const confident = only.score >= 100;
        const head = confident
          ? `「${keyword}」唯一命中【${only.card.cn_name}】${note}：`
          : `「${keyword}」在卡库里只有 1 条接近的结果，实际名称是【${only.card.cn_name}】（没有完全同名的卡）${note}：`;
        const tail = confident
          ? ''
          : `\n\n⚠️ 没有与「${keyword}」完全同名的卡，上面是最接近的一张。${
              /[\u3400-\u9fff]/.test(keyword)
                ? '若看着不对，去掉「的」之类虚词换核心词再搜一次；'
                : '若看着不对，换更完整的卡名、或直接给卡片密码；'
            }不要把「${only.card.cn_name}」当成用户说的那张照答。`;
        return { content: `${head}\n\n${formatCard(only.card, { includeFaq: useFaq })}${tail}` };
      }

      // ── 有一张完全同名：用它，但把其他相近的也列出来备查 ──
      if (exact.length === 1) {
        const main = exact[0];
        const rest = scored.filter((x) => x.card !== main.card);
        // 已经确定是哪张了，备选只列少量，避免把上下文塞满无关卡名
        const restCap = Math.min(candLimit, 5);
        const restBlock = `\n\n— 另有 ${rest.length} 张名字相近的卡（多半不是用户要的，除非他说的正是下面某张）：\n${buildCandidateList(rest, restCap)}`;
        return {
          content: `「${keyword}」精确命中【${main.card.cn_name}】${note}：\n\n${formatCard(main.card, { includeFaq: useFaq })}${restBlock}`
        };
      }

      // ── 没有完全同名的、且有多个候选 → 只给候选清单，甄别交给模型 ──
      const head = exact.length > 1
        ? `「${keyword}」有 ${exact.length} 张同名卡，需要先确认是哪一张：`
        : `「${keyword}」搜到 ${cards.length} 张${note}，没有完全同名的卡，需要先确认是哪一张（下面按卡库相关度排序）：`;
      return {
        content: `${head}\n\n${buildCandidateList(scored, candLimit)}\n（共 ${cards.length} 条，只列了前 ${Math.min(candLimit, cards.length)} 条）\n\n→ 选一张（把它的**名称**原样传给 ygo-ruling__get_card 取回原文），或者把候选清单发给用户让他挑。`
      };
    }
  });

  // ② 批量精确取卡
  api.registerTool({
    id: 'get_card',
    name: '取卡片原文（可多张）',
    description: '按卡名或密码精确取回一张或多张卡的完整卡面。判例问题常常一次涉及好几张卡（例如"某卡被解放后某效果还能不能发动"），用它可以一次把涉及的卡都取回来，比逐张搜索省事。',
    category: 'knowledge',
    icon: '📇',
    parameters: {
      type: 'object',
      properties: {
        cards: {
          type: 'string',
          description: '一张或多张卡，用逗号 / 顿号 / 换行分隔。可以写卡名，也可以写卡片密码（数字）。例如「灰流丽, 增殖的G」或「14558127」'
        }
      },
      required: ['cards']
    },
    async execute(_ctx, args) {
      const tokens = String(args?.cards ?? '')
        .split(/[,，、;；\n]+/)
        .map((s) => s.trim())
        .filter(Boolean);
      if (!tokens.length) return { content: '错误：请给出至少一个卡名或卡片密码', isError: true };

      const conf = cfg() || {};
      const timeout = num(conf.timeoutMs, 15000);
      const useFaq = conf.includeFaqHint !== false;
      const blocks = [];
      let hit = 0;
      let miss = 0;

      for (const token of tokens.slice(0, MAX_BATCH)) {
        try {
          const cards = await searchYgocdb(token, timeout);
          if (!cards.length) {
            miss++;
            blocks.push(`✗ 「${token}」：没找到。换个写法（中文全名 / 日文英文名 / 密码）再试。`);
            continue;
          }
          const { card, score } = pickBest(cards, token);
          hit++;
          let caution = '';
          if (score < 100) {
            // 并列最接近的另外几张也报出来 —— 否则模型只有"一张疑似"的信息，
            // 既没法判断、也没法把备选列给用户挑。
            const ties = cards.filter((c) => scoreCard(c, token).score === score && c !== card).slice(0, 3);
            const altLine = ties.length
              ? `\n   并列最接近的还有：${ties.map((c) => c.cn_name).join(' / ')}`
              : '';
            caution = `\n⚠️ 没有完全同名的卡，上面这张是卡库给出的最接近匹配（原查询「${token}」）。先确认是不是用户要的那张再下结论；拿不准就用 ygo-ruling__search_card 看完整候选清单，或者直接问用户。${altLine}`;
          }
          blocks.push(formatCard(card, { includeFaq: useFaq }) + caution);
        } catch (error) {
          miss++;
          blocks.push(`✗ 「${token}」：查询失败（${error?.message ?? error}）`);
        }
      }

      const skipped = tokens.length > MAX_BATCH ? `\n（一次最多 ${MAX_BATCH} 张，后面 ${tokens.length - MAX_BATCH} 个没有处理）` : '';
      return { content: `${blocks.join('\n\n')}\n\n— 取到 ${hit} 张${miss ? `，${miss} 个没取到` : ''}${skipped}` };
    }
  });

  // ③ 取 Lua 脚本
  //
  // ⚠️ 入参从「卡片密码」放宽为「卡名或密码」（2026-10-05）：
  //    卡面/候选清单都不再给模型看密码，所以模型手上正常的输入是**卡名**，
  //    这里自己查一次卡库把密码解出来。输出同样要脱敏 —— 脚本文件名与 raw URL
  //    里都带密码，一律不外露，只给来源目录页。
  api.registerTool({
    id: 'get_script',
    name: '取卡片YGO脚本',
    description: '按卡名（或卡片密码）取回 YGO/EDOPro Lua 脚本源码。优先读本地全量镜像（数据目录 scripts-mirror/，离线、零等待），没有才按 official → pre-release → ygopro-scripts（先行卡）在线抓。脚本是模拟器对这张卡的真实实现，是判例问题的终审依据 —— 判断"能不能发动 / 会不会被无效 / 被无效的是「发动」还是「效果」/ 连锁怎么处理 / 取不取对象"这类问题必须先取脚本，不要凭卡文复述推理。cards 参数支持逗号分隔一次取多张：判例题要把**所有涉事卡**（被问的卡＋施放无效/干扰的那张）一次传全。注意：通常怪兽一般没有脚本，个别新卡尚未收录，"没找到"是正常结果。',
    category: 'knowledge',
    icon: '📜',
    parameters: {
      type: 'object',
      properties: {
        cards: { type: 'string', description: '逗号分隔的多张卡名（或密码），如：炎舞-「天玑」, 兽带斗神“王者”轩辕十四。判例题把涉事卡一次传全，省得一张一张取。' },
        card: { type: 'string', description: '单张卡名（中文全名/日文名/英文名）或卡片密码（8 位数字）。与 cards 二选一。' }
      }
    },
    async execute(_ctx, args) {
      // cards（多张，逗号分隔）与 card / cardId（旧参数名，向后兼容）都收。
      const raw = String(args?.cards ?? args?.card ?? args?.cardId ?? '').trim();
      if (!raw) return { content: '错误：请给出卡名或卡片密码（多张用逗号分隔）', isError: true };
      const names = raw.split(/[，,、]/).map((s) => s.trim()).filter(Boolean).slice(0, SCRIPT_BATCH_MAX);

      const conf = cfg() || {};
      const timeout = num(conf.timeoutMs, 15000);
      const options = {
        timeoutMs: timeout,
        cacheHours: num(conf.scriptCacheHours, 168),
        prefixes: proxyPrefixes(conf.scriptProxy)
      };
      const cap = clamp(num(conf.maxScriptChars, 12000), 1000, SCRIPT_HARD_CAP);

      // 取一张 → 输出块。ok=false 时 block 是给模型的指引；hard=true 表示该重试/换法，
      // 不是"没脚本"（没脚本是正常结果，不算 error）。
      async function oneScript(input) {
        const isDigits = /^\d{4,12}$/.test(input);
        let cardId = isDigits ? input : '';
        let display = '';

        if (isDigits) {
          // 直接把密码当输入时，顺手查个名字出来 —— 输出里只给名字，不回显密码。
          try {
            const cards = await searchYgocdb(input, timeout);
            if (cards.length) {
              const { card } = pickBest(cards, input);
              if (card?.cn_name) display = `【${card.cn_name}】`;
            }
          } catch {
            // 查不到名字不影响取脚本
          }
        } else {
          try {
            const cards = await searchYgocdb(input, timeout);
            if (!cards.length) {
              return { ok: false, hard: true, block: `按卡名「${input}」没查到卡，拿不到脚本。换个写法（中文全名 / 日文英文名）再试，或者请用户把卡名写全一点。` };
            }
            const { card, score } = pickBest(cards, input);
            cardId = String(card.id || '').replace(/\D/g, '');
            display = `【${card.cn_name}】`;
            if (!cardId) return { ok: false, hard: true, block: `卡名「${input}」解析不到卡片密码，无法取脚本。` };
            if (score < 100) {
              return { ok: false, hard: true, block: `「${input}」没有完全同名的卡（最接近的是【${card.cn_name}】），先确认是哪一张再取脚本 —— 用 ygo-ruling__search_card 看候选清单，或者直接问用户。` };
            }
          } catch (error) {
            return { ok: false, hard: true, block: `按卡名解析卡片密码失败（${input}）：${error?.message ?? error}` };
          }
        }

        try {
          const result = await fetchScript(cardId, options);
          if (!result.found) {
            return { ok: false, hard: false, block: `${display || `「${input}」`}没有取到脚本。可能原因：① 通常怪兽/没有需要脚本的效果；② 该卡尚未被 Project Ignis 收录（新卡常见）；③ 网络暂时不通。\n对这张卡：退回纯卡片文本+通用规则分析，分析前必须**逐字抄写**卡面原文那一小句，并在回答里注明"这张卡没有脚本，按卡文推的，不是脚本审计" —— 不要假装看过脚本。` };
          }
          const truncated = result.code.length > cap;
          const code = truncated ? result.code.slice(0, cap) : result.code;
          const head = [
            `${display ? `${display}的` : ''}YGO/EDOPro Lua 脚本 —— 来源：${result.source}${result.fromMirror ? '（本地镜像）' : result.fromCache ? '（本地缓存）' : ''}`,
            sourcePageOf(result.source),
            truncated ? `（脚本共 ${result.code.length} 字，已截断到 ${cap} 字）` : `（共 ${result.code.length} 字）`
          ].join('\n');
          return { ok: true, block: `${head}\n\n\`\`\`lua\n${code}\n\`\`\`` };
        } catch (error) {
          return { ok: false, hard: true, block: `取脚本失败（${display || input}）：${error?.message ?? error}` };
        }
      }

      const results = [];
      for (const name of names) results.push(await oneScript(name));
      const okCount = results.filter((r) => r.ok).length;

      if (names.length === 1) {
        const only = results[0];
        return { content: only.block, isError: only.hard === true };
      }
      const joined = results
        .map((r, i) => `【第 ${i + 1} 张 / 共 ${names.length} 张】\n${r.block}`)
        .join('\n\n────────\n\n');
      return {
        content: `一次取了 ${names.length} 张，取到脚本 ${okCount} 张。没取到的那张按上面指引退回卡文分析。\n\n${joined}`,
        isError: okCount === 0 && results.some((r) => r.hard)
      };
    }
  });

  // ④ 发卡片插图
  //
  // ⚠️ 参数是**卡名**，不是图片地址 —— 图床 URL 形如 `pics/<卡片密码>.jpg`，
  //    让模型拿到 URL 就等于把密码又泄给它（同 formatCard 不显示密码的理由，2026-10-05）。
  //    所以"查 id → 拼 URL → 发图"全在这里做，模型只知道"发了哪张卡的图"。
  api.registerTool({
    id: 'send_card_image',
    name: '发送卡片图片',
    description: '把一张游戏王卡片的插图发到当前聊天。参数写卡名（中文全名/简称/日文/英文名都行）或卡片密码，不用给图片地址。用户问"这是什么卡 / 效果是什么"时，把图片和卡片文本一起发出去更直观；拿不准他说的是哪张、要向他确认时，也可以把最可能那张的图发过去让他认。',
    category: 'media',
    icon: '🖼️',
    parameters: {
      type: 'object',
      properties: {
        card: { type: 'string', description: '卡名（中文全名 / 简称 / 日文名 / 英文名），或卡片密码。必须是能确定的那一张。' },
        note: { type: 'string', description: '可选：跟着这张图一起发的一句话，如"你说的是这张吗？"' }
      },
      required: ['card']
    },
    async execute(ctx, args) {
      const input = String(args?.card ?? '').trim();
      if (!input) return { content: '错误：请给出卡名或卡片密码', isError: true };
      if (!ctx?.chatKey || typeof ctx.sender?.sendImage !== 'function') {
        return { content: '当前环境不支持发图片。', isError: true };
      }

      const conf = cfg() || {};
      const timeout = num(conf.timeoutMs, 15000);
      const isDigits = /^\d{4,12}$/.test(input);

      let cardId = isDigits ? input.replace(/\D/g, '') : '';
      let name = '';
      try {
        const cards = await searchYgocdb(input, timeout);
        const picked = cards.length ? pickBest(cards, input) : null;
        if (picked?.card) {
          name = picked.card.cn_name || '';
          if (!isDigits) {
            // 卡名必须**完全同名**才发图 —— 含糊的名（"羽毛扫"）发错图比不发更糟。
            if (picked.score < 100) {
              return {
                content: `「${input}」没有完全同名的卡（最接近的是【${picked.card.cn_name}】）。先用 ygo-ruling__search_card 看候选清单、或直接问用户要完整卡名，别发一张可能不对的图。`
              };
            }
            cardId = String(picked.card.id || '').replace(/\D/g, '');
          }
        }
      } catch (error) {
        return { content: `查卡片信息失败：${error?.message ?? error}`, isError: true };
      }
      if (!cardId) return { content: `没能确定「${input}」是哪张卡，发不了图。`, isError: true };

      const url = cardImageUrl(cardId);
      // 顺带下载一份 base64 作回退：协议端（QQ 客户端）取不到外网图时自动改用内联。
      // 实测这张图 70~90KB，下载很快；失败了也不影响 —— url 那条路还有机会。
      let dataUrl = '';
      try {
        const res = await fetch(url, { headers: { 'user-agent': UA }, signal: AbortSignal.timeout(timeout) });
        if (res.ok) {
          const buf = Buffer.from(await res.arrayBuffer());
          if (buf.length) dataUrl = `base64://${buf.toString('base64')}`;
        }
      } catch { /* 交给协议端直接取 URL */ }

      try {
        await ctx.sender.sendImage(ctx.chatKey, { url, dataUrl }, { note: args?.note ?? null });
      } catch (error) {
        return { content: `发图失败：${error?.message ?? error}`, isError: true };
      }
      try {
        const note = args?.note ? `:${String(args.note).slice(0, 40)}` : '';
        ctx.session?.sent?.push?.({ type: 'image', text: `[图片${note}]`, at: new Date().toLocaleTimeString('zh-CN', { hour12: false }) });
        ctx.emit?.('session-update', ctx.session?.id);
      } catch { /* 留档失败不影响已发出的图 */ }

      // 返回值里**不带 URL**：模型看到地址就会念出来，而地址里含卡片密码。
      return { content: `${name ? `【${name}】` : '这张卡'}的插图已发出。图片地址不需要你操心，也不要在回答里编造或复述图片链接。` };
    }
  });

  log('游戏王判例助手已注册（search_card / get_card / get_script / send_card_image）');
}

// ── 精简模式：prompt.lean-context ─────────────────────────────────────────
//
// 为什么要有这个东西
//   判一道判例真正用得上的只有本技能的 playbook（~3.8k 字）+ 四个查卡工具。
//   但默认每条请求都会带上：12,167 字系统提示（群聊人设 + 全部技能说明）+
//   10,985 字本次输入（角色卡 6.2k + 聊天记录 3.7k + 记忆/表情包/引导）。
//   实测合计 23,150 字符里只有 16% 跟判例有关 —— 既费钱，又让模型在噪音里找重点
//   （2026-10-07 那几次判例判错，有不少就是在人设废话里跑偏的）。
//
// 做法：核心新增能力名 `prompt.lean-context`，技能返回
//   { system, historyLimit, tools } 就能接管这一轮的提示词与工具表；
//   **别的一切照旧**——会话记录、成本统计、中止、重试、留档、发送管道全走原链路。
//
// 判错的方向必须是"少省一次钱"
//   ① 被叫到才接管（私聊 / 被 @ / 拍一拍我 / 命中关键词；reach 由核心算，口径与
//      唤醒判定同源）。群里路过的闲聊即使满屏术语也不接管 —— 人设不会莫名消失。
//   ② 话里要有**足够强**的游戏王信号（见 ygoSignal）：提到"游戏王"、【】里像卡名，
//      或同时出现两个以上游戏王术语。光凭"卡组""效果"就抢人设，翻车率太高。
//      ⚠️ 曾经把「」『』也当强信号，实测中文闲聊里它们就是普通引号
//        （"「今天不想上班」""他回了「好好好」"），一律误判成判例问题。
//   ③ 接管时明确给模型留退路：发现"这其实不是在问游戏王"就 finish，
//      核心会自动用完整上下文重跑一遍（orchestrator 的 #runAgent 回退）。
//   ④ 设置里 leanMode 一关，这段代码完全不参与 —— 立刻回到原来的行为。

/**
 * 【】里装的不是卡名的常见词：公告 / 事务 / 上下文标签。
 * 卡名和这些词几乎不会撞车，所以这张表可以把「【通知】明天开会」挡在外面，
 * 同时放行「【灰流丽】」这种"光有卡名、没有任何术语"的问法。
 */
const NON_CARD_BRACKET = new Set([
  '通知', '重要', '求助', '公告', '注意', '提醒', '分享', '转发', '记录', '问题',
  '活动', '投票', '接龙', '报名', '须知', '福利', '资源', '更新', '维护', '紧急',
  '讨论', '总结', '建议', '说明', '规则', '教学', '科普', '提问', '回复', '补充',
  '勘误', '已修复', '存档', '直播', '搬运', '招募', '广告', '闲聊', '水贴', '教程',
  '攻略', '警告', '提示', '新闻', '资讯', '公告栏', '图片', '表情包', '视频', '音频',
  '文件', '链接', '截图', '已读', '置顶', '撤回', '测试', '示例', '备注', '草稿'
]);

/** 【卡名】：卡名的书写习惯。取第一条即可（一条消息里通常只引一个卡名）。 */
const CARD_QUOTE_RE = /【([^】\n]{1,16})】/;

/**
 * 「」『』：**不强**信号。它们在中文聊天里就是普通引号（引用别人的话、强调），
 * 单凭它们判判例问题会大量误伤；必须搭配至少一个游戏王术语才算（见 ygoSignal）。
 */
const LOOSE_QUOTE_RE = /[「『][^」』\n]{1,30}[」』]/;

/** 提到作品本身。命中一条就够（"游戏王"三个字在群里基本只有这一种含义）。 */
const YGO_TOPIC_WORDS = ['游戏王', 'ocg', 'ygopro', 'edopro', 'master duel'];

/**
 * 游戏王术语表：命中 **2 个以上不同词** 才算强信号（带「」引用时 1 个即可，见 ygoSignal）。
 * 刻意不收"星""阶段""卡片"这种单字/泛词 —— 它们在其他话题里太常见
 * （"星期""项目阶段""会员卡片"），会让判定变得不可控。
 */
const YGO_TERMS = [
  '怪兽', '魔法卡', '陷阱卡', '效果', '发动', '无效', '连锁', '召唤', '特殊召唤',
  '同调', '超量', '灵摆', '连接召唤', '解放', '破坏', '墓地', '除外', '卡组', '手牌',
  '攻击力', '守备力', '时点', '取对象', '裁定', '判例', '事务局', '调整中', '衍生物',
  '素材', '里侧表示', '表侧表示', '送去墓地', '回到手牌', '速攻魔法', '永续魔法',
  '永续陷阱', '反击陷阱', '仪式召唤', '融合召唤', '伤害步骤', '主要阶段', '抽卡阶段'
];

/** 精简模式给模型的工具白名单。工具表本身也占 token，"给一堆用不上的工具"还会让模型分心。 */
const LEAN_TOOLS = [
  'ygo-ruling__search_card',
  'ygo-ruling__get_card',
  'ygo-ruling__get_script',
  'ygo-ruling__send_card_image',
  'send_message',
  'get_message_images',
  'finish'
];

const SKILL_DIR = path.dirname(fileURLToPath(import.meta.url));
let playbookCache = null;

/**
 * 读自己的 skill.json 取那段判例 playbook（精简模式的系统提示要发**同一份**）。
 *
 * 为什么不把 3,827 字正文再抄一份到这个文件：两份副本必然跑偏（改了 skill.json
 * 忘了改这里，判例规则就只在一条路径上生效），而这种"规则只在某些轮生效"的
 * 不一致极难排查。读文件 + 缓存，失败就退化（少规则，但不会崩）。
 */
function playbook() {
  if (playbookCache !== null) return playbookCache;
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(SKILL_DIR, 'skill.json'), 'utf8'));
    playbookCache = String(raw?.prompt?.sections?.[0]?.content ?? '').trim();
  } catch (error) {
    playbookCache = '';
    log?.(`精简模式读不到 skill.json 的 playbook，将只发精简协议：${error?.message ?? error}`);
  }
  return playbookCache;
}

/** 命中了几个不同的游戏王术语。 */
function countYgoTerms(t) {
  let hits = 0;
  for (const w of YGO_TERMS) if (t.includes(w)) hits += 1;
  return hits;
}

/**
 * 【】里像不像卡名：不能是公告类词，且要含中日文字符。
 * 后半条挡掉「【2026】年终总结」「【v1.2】更新日志」这类。
 */
export function cardishQuote(text) {
  const m = CARD_QUOTE_RE.exec(String(text ?? '').toLowerCase());
  if (!m) return false;
  const inner = m[1].trim();
  if (!inner) return false;
  if (NON_CARD_BRACKET.has(inner)) return false;
  return /[\u4e00-\u9fff\u3040-\u30ff]/.test(inner);
}

/**
 * 这句话里的游戏王信号够不够强（够强才值得抢掉群聊人设）。
 *
 * 判错的方向必须是"少省一次钱"：宁可让这条走全量提示词（贵一点、但绝不会答错人设），
 * 也不要为了省钱把普通闲聊按判例问题处理。
 * 实测 41 条中文闲聊零误判、17 条真问题零漏判（回归见 test/ygo-lean-context.mjs）。
 */
export function ygoSignal(text) {
  const t = String(text ?? '').toLowerCase();
  if (!t.trim()) return false;
  if (YGO_TOPIC_WORDS.some((w) => t.includes(w))) return true;
  const terms = countYgoTerms(t);
  if (terms >= 2) return true;
  if (cardishQuote(t)) return true;
  // 「」『』单独出现不算；搭一个术语（如「青眼白龙」的效果）才算。
  if (terms >= 1 && LOOSE_QUOTE_RE.test(t)) return true;
  return false;
}

/** 精简模式的系统提示：一句话交代身份与语气 + 判例 playbook + 本轮工具面 + 退路。 */
export function leanSystem() {
  return [
    '你是群里的游戏王（OCG）玩家，平时混在群里聊天；这一轮只干一件事：把群友问的卡片 / 规则 / 判例答清楚。',
    '用日常语气、说人话、简短（多数 1~3 句；判例分析可以分条发）。不要用 Markdown（**、#、代码块在 QQ 上会显示成乱码）。',
    '',
    playbook(),
    '',
    '【本轮的工具】只有这些，别的都没给：',
    '- ygo-ruling__search_card / ygo-ruling__get_card / ygo-ruling__get_script / ygo-ruling__send_card_image：搜卡、取卡面、取 Lua 脚本、发卡图。',
    '- send_message：**唯一**能把话发到 QQ 的工具（想分条就传数组）。需要引用某条消息时带 replyToMessageId，用【当前消息】里的 #数字。',
    '- get_message_images：对方发了 [图片]（常见：直接甩一张卡片截图）时用它看图。',
    '- finish：确实不该说话时用它收尾。',
    '',
    '⚠️ 这一轮只带了最近几轮对话和你这次要处理的消息，没有人设设定、也没有搜索/表情包/记忆这类工具。',
    '如果你发现这条消息其实不是在问游戏王（或跟卡片规则无关），**不要硬答**：直接调用 finish，reason 写"非游戏王问题" —— 系统会自动改用完整上下文重新处理一次。'
  ].join('\n');
}

/** 拿本技能的设置（默认值已由 manifest.settings 合并；由 setup() 注入的 cfg 读取）。 */
function leanSettings() {
  try { return cfg() || {}; } catch { return {}; }
}

/**
 * 精简模式的接管判定 + 产物。
 * 返回 null = 这一轮不接管，一切照原样（最常见的分支）。
 */
export function leanContextFor(ctx = {}) {
  const conf = leanSettings();
  if (conf.leanMode === false) return null;                 // ④ 总开关
  const reach = ctx.reach || {};
  if (!reach.addressed) return null;                        // ① 没被叫到 → 不抢人设
  const text = (ctx.triggerEntries || []).map((e) => String(e?.text || '')).join('\n');
  if (!ygoSignal(text)) return null;                        // ② 信号不够强 → 当普通聊天
  const rawLimit = Number(conf.leanHistory);
  return {
    id: SKILL_ID,
    label: '游戏王判例',
    system: leanSystem(),
    historyLimit: Number.isFinite(rawLimit) ? Math.max(0, Math.min(50, Math.round(rawLimit))) : 8,
    tools: LEAN_TOOLS
  };
}

/** 能力提供者（核心按能力名取用；没启用的技能不会被取到）。 */
export const providers = {
  'prompt.lean-context': (ctx) => leanContextFor(ctx)
};

/** 自测用：纯判定/拼装函数（不碰网络与磁盘）。 */
export const internals = { ygoSignal, cardishQuote, leanSystem, leanContextFor, LEAN_TOOLS, playbook };

// 依赖自检：必须**同步**返回。要异步探测就不能在这里做（Promise 是 truthy，
// 会被当成"可用"，表现为界面显示生效但实际跑不通）。网络好坏留到工具里回报。
export function available() {
  return true;
}
