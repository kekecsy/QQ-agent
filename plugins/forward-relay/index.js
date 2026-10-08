// 屎壳郎（forward-relay）：把「注入群」里的合并转发，搬给「导向群」。
//
// ══════════════════════════════════════════════════════════════════════
// 解决的原始问题
// ══════════════════════════════════════════════════════════════════════
// 主人同时待在一堆群里。有些群里的合并转发（聊天记录卡片）值得让另一个群也看到，
// 但手工转发要点开、选中、选群，重复劳动；更烦的是**同一条内容被转来转去**，
// 群里刷屏。于是需要这么一个东西：
//   · 盯住几个「注入群」，任何人发的合并转发都被展开、存档（留时间戳，24h 过期）；
//   · 对每个「导向群」查它的存档里有没有**一模一样**的那条 —— 有就彻底安静；
//   · 没有才问一句（默认 ask 模式：私聊主人一条固定文案，0 token），主人点头才发。
//
// ══════════════════════════════════════════════════════════════════════
// 关键设计（都是踩出来的，别改回去）
// ══════════════════════════════════════════════════════════════════════
// ① **不改核心，靠定时器发现新转发**：钩子（before-context / before-llm-messages）只在
//    薄荷被触发那一轮跑；注入群里薄荷不说话时钩子根本不跑。所以主路径是定时轮询
//    `data/messages/group_<群号>.json`（src/store.js 的聊天存档），钩子只是"顺手扫一次"。
// ② **一律用 mid 去 get_forward_msg 拿真节点**：store 里的 text 有两种形态——核心 ingest
//    展开成功的 `[合并转发 共N条]\n…`，和展开失败只剩的 `[合并转发聊天记录]` 占位符。
//    不能假设有"共N条"，也不能拿文本当内容源。取不到就记一笔、最多重试 3 次，
//    别把已经过期的 mid 无限重试（日志会被刷爆）。
// ③ **判定"原模原样"用归一化指纹**：去掉 `[合并转发 共N条]` 头、去掉所有空白后取 sha1。
//    同一个转发两次展开的换行/条数差异不该算成不同内容。
// ④ **发送必须重组节点**：SnowLuma 明确禁止把合并转发卡片原样重发（long-msg resid 只对
//    源会话有效），只能用 `{type:'node',data:{user_id,nickname,content}}` 重新上传。
//    节点里的段还要过滤（不认识的段类型 SnowLuma 直接抛 UNKNOWN_TYPE，整张转发失败），
//    白名单 text/image/face/at/record/video，其余折成文本占位符并记数。
// ⑤ **合并转发失败自动回退纯文本**（textFallback）：宁可发一段朴素文字，也不要整条丢掉。
// ⑥ **只处理"插件装载之后"的新消息**（state.armedAt）：否则第一次跑就把过去几个月
//    几百条转发全刷出来 —— 那是灾难不是功能（照抄收件箱的 wxArmedAt 思路）。
// ⑦ **测试/告警一律走私聊**：`\转发测试`、ask 询问、auto 告知、失败告警全发主人私聊；
//    只有"真正的转发任务"才可能落到群里（指纹判定通过 + 主人确认 / 模型判断）。
// ⑧ **任何一步失败只记日志**：钩子和定时器都在热路径旁边，抛出去会连累正常聊天。
//
// 成本：判定全在本地（指纹 + 文件 IO）—— ask 模式 0 token；auto 模式只多一段提示词。
//
// 存档：`文档文件夹/转发存档/<群号>/<YYYY-MM-DD_HHmm>_<指纹8位>.md`
// （薄荷能用文档工具直接读，file-edit 也能改），头部是元信息，下面是展开正文。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DATA_DIR, getConfig } from '../../src/config.js';

const ID = 'forward-relay';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const LIB_DIR = path.join(HERE, 'lib');

/** 同一条 mid 最多尝试拉几次节点（成功后进 processedMids，失败 3 次也进，避免无限重试）。 */
const MAX_FETCH_RETRY = 3;
/** processedMids 的 LRU 上限。 */
const MAX_PROCESSED = 5000;
/** 待处理暂存上限（每条正文最多 20 万字符，不设上限状态文件会失控）。 */
const MAX_PENDING = 30;
/** 已处理历史上限。 */
const MAX_DONE = 200;
/** 同群/同人 1 秒内不重复发（模型可能连调两次同一目标）。 */
const SEND_MIN_GAP_MS = 1000;
/**
 * 「导向群已经有这份内容了，还要再发一遍吗？」的许可有效期。
 * 主人点名要发的群如果已经有同一条内容，第一次只回报、不发；
 * 同一个编号 + 同一批群在这么久之内再回一次同样的口令，才按"强发"处理。
 */
const FORCE_CONFIRM_MS = 10 * 60000;

/**
 * 加载同目录 lib/*.js。
 *
 * ⚠️ 必须给 import URL 带上**该文件自己的 mtime+size**：核心热重载只给入口 index.js
 * 加时间戳（plugin-loader `import(entryUrl?t=Date.now())`），lib 会命中模块缓存 ——
 * 改了 lib 不生效，还会出现"新入口 + 旧 lib"的幽灵组合。
 * （这条经验是 qzone-diary 踩出来的，这里照抄 qq-file-intake。）
 */
let libCache = new Map();
async function lib(name) {
  let tag = 'v0';
  try {
    const st = fs.statSync(path.join(LIB_DIR, name));
    tag = `v${Math.round(st.mtimeMs).toString(36)}x${st.size.toString(36)}`;
  } catch { /* 读不到就用 v0，import 自己会报错 */ }
  const key = `${name}?${tag}`;
  if (!libCache.has(key)) libCache.set(key, import(`./lib/${name}?${tag}`));
  return libCache.get(key);
}

// ── 日志（插件 stdout 在真机上看不见，所以自己也落一份盘）──────────────
let apiRef = null;
function logLine(kind, msg) {
  const line = `[${kind}] ${msg}`;
  try { apiRef?.log?.(line); } catch { /* ignore */ }
  try {
    const dir = path.join(DATA_DIR, 'logs');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${ID}.log`);
    try {
      if (fs.statSync(file).size > 2 * 1024 * 1024) fs.renameSync(file, `${file}.1`);
    } catch { /* 没有就新建 */ }
    fs.appendFileSync(file, `${new Date().toLocaleString('zh-CN', { hour12: false })} ${line}\n`, 'utf8');
  } catch { /* 日志失败不影响功能 */ }
}
const log = (m) => logLine('屎壳郎', m);
const warn = (m) => logLine('屎壳郎⚠️', m);

/* ══════════════════════════════════════════════════════════════════════
   设置
   ══════════════════════════════════════════════════════════════════════ */

const DEFAULTS = {
  enabled: true,
  mode: 'ask',
  injectGroups: '',
  targetGroups: '',
  ttlHours: 24,
  scanIntervalSec: 20,
  cleanupIntervalMin: 30,
  archiveDir: '',
  maxArchivePerGroup: 300,
  previewLines: 3,
  previewChars: 300,
  askTo: '',
  // 未回复超时（分钟）：ask 模式下扫到的暂存，超过这么久主人还没拍板就**自动丢掉**。
  // 主人 2026-10-04 定的规矩：5 分钟不回复 = 当没看见（静默丢，只写日志）。
  // 0 = 不超时（一直等），旧版的「20 分钟提醒一次」已按主人要求取消（5 分钟就丢，提醒永远来不及）。
  replyTimeoutMin: 5,
  notifyOnAuto: true,
  textFallback: true,
  armedPolicy: 'new-only',
  quietGroups: '',
  judgeGuide: '',
  minConfidence: 7,
  historyFallback: true,
  historyCount: 30,
  // 原文先发一份：扫到新转发就把**原始合并转发**（重组节点）直接私聊给主人，
  // 比纯文字预览直观 —— 主人点开就是原始聊天记录。
  pushOriginal: true,
  // 一轮最多推几条原文，防止某个群一口气刷 20 条转发把主人私聊刷爆
  maxPushPerScan: 5,
  // 暂存去重窗口（小时）：同一份内容（指纹相同）在窗口内只问主人一次。
  // 为什么要按指纹而不是 mid：兜底拉取（get_group_msg_history）每轮给出的
  // message_id 会变，同一份转发会被反复当成"新转发"再问你一遍（2026-10-04 真机：
  // 同指纹 77528dd6 的 37 条被暂存了三次）。0 = 关掉去重。
  dedupeHours: 12
};

let cfgFn = () => ({});
// 自动化回执（auto-receipt）软依赖：没装那个插件时它就是个空函数，一行都不会多干。
let receiptTell = () => {};
function settings() {
  let raw = {};
  try { raw = cfgFn?.() || {}; } catch { raw = {}; }
  const s = { ...DEFAULTS, ...raw };
  const core = mods?.core;
  const clamp = core ? core.clampInt : (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);
  s.enabled = s.enabled !== false;
  s.mode = s.mode === 'auto' ? 'auto' : 'ask';
  s.ttlHours = clamp(s.ttlHours, DEFAULTS.ttlHours, 0, 24 * 365);
  s.scanIntervalSec = clamp(s.scanIntervalSec, DEFAULTS.scanIntervalSec, 5, 3600);
  s.cleanupIntervalMin = clamp(s.cleanupIntervalMin, DEFAULTS.cleanupIntervalMin, 1, 1440);
  s.maxArchivePerGroup = clamp(s.maxArchivePerGroup, DEFAULTS.maxArchivePerGroup, 1, 100000);
  s.previewLines = clamp(s.previewLines, DEFAULTS.previewLines, 1, 20);
  s.previewChars = clamp(s.previewChars, DEFAULTS.previewChars, 20, 4000);
  s.archiveDir = String(s.archiveDir || '').trim();
  s.injectGroups = String(s.injectGroups || '');
  s.targetGroups = String(s.targetGroups || '');
  s.quietGroups = String(s.quietGroups || '');
  // auto 模式的判定口径（主人给的文本，留空 = 薄荷自己拿主意）
  s.judgeGuide = String(s.judgeGuide || '').trim().slice(0, 4000);
  // 自信度闸门：auto 模式下 relay_send 必须带 confidence（1-10），低于这个数直接不发
  s.minConfidence = clamp(s.minConfidence, DEFAULTS.minConfidence, 1, 10);
  s.askTo = String(s.askTo || '');
  // 0 = 不超时（显式认 0，别用 `Number(v) || 默认值` 那种写法）
  s.replyTimeoutMin = clamp(s.replyTimeoutMin, DEFAULTS.replyTimeoutMin, 0, 1440);
  s.notifyOnAuto = s.notifyOnAuto !== false;
  s.textFallback = s.textFallback !== false;
  s.armedPolicy = s.armedPolicy === 'all' ? 'all' : 'new-only';
  // 兜底拉取：注入群不在核心白名单（allow.groups）里时，核心根本不给它写聊天存档，
  // 插件读文件永远读不到东西 —— 这时改用 OneBot get_group_msg_history 只读拉最近几条。
  s.historyFallback = s.historyFallback !== false;
  s.historyCount = clamp(s.historyCount, DEFAULTS.historyCount, 5, 200);
  // 原文直接私聊给主人（可关）；一轮最多推几条
  s.pushOriginal = s.pushOriginal !== false;
  s.maxPushPerScan = clamp(s.maxPushPerScan, DEFAULTS.maxPushPerScan, 1, 20);
  // 0 = 关掉暂存去重（显式认 0）
  s.dedupeHours = clamp(s.dedupeHours, DEFAULTS.dedupeHours, 0, 720);
  return s;
}

/** 群号解析（settings 里拿到的都是字符串）。 */
const gids = (raw) => (mods ? mods.core.parseGroupIds(raw) : []);
/** 主人 QQ 解析口径与 owner-identity / private-receipt 一致：只认 5~12 位数字。 */
const ownerIds = (raw) => (mods ? mods.core.parseGroupIds(raw) : []);

/* ══════════════════════════════════════════════════════════════════════
   路径
   ══════════════════════════════════════════════════════════════════════ */

let stateFileOverride = '';
const stateFile = () => stateFileOverride || path.join(DATA_DIR, ID, 'state.json');
const archiveRoot = () => settings().archiveDir || path.join(DATA_DIR, 'documents', '转发存档');
const groupDir = (groupId) => path.join(archiveRoot(), String(groupId));
const archivePathFor = (item) => path.join(
  groupDir(item?.srcGroup),
  `${mods.core.stampOf(item?.at)}_${item?.fp8}.md`
);

/* ══════════════════════════════════════════════════════════════════════
   状态
   ══════════════════════════════════════════════════════════════════════ */

let st = null;          // lib/store.js 的 store 实例
let mods = null;        // { core, store }
let midSet = new Set(); // processedMids 的内存镜像
let lastSendAt = new Map();
let scanBusy = false;
let nowFn = null;
const now = () => (typeof nowFn === 'function' ? Number(nowFn()) : Date.now());
const sleep = (ms) => new Promise((r) => { setTimeout(r, Math.max(0, Number(ms) || 0)); });

async function boot() {
  if (!mods) {
    const [core, storeMod] = await Promise.all([lib('core.js'), lib('store.js')]);
    mods = { core, store: storeMod };
  }
  if (!st) {
    st = mods.store.createStore(stateFile(), { onWarn: warn });
    st.load();
    ensureShape();
  }
  return mods;
}

function ensureShape() {
  const d = st.data;
  if (!Number(d.version)) d.version = 1;
  if (!Number(d.armedAt)) d.armedAt = 0;
  if (!Number(d.nextId)) d.nextId = 1;
  if (!Array.isArray(d.pending)) d.pending = [];
  if (!Array.isArray(d.done)) d.done = [];
  if (!Array.isArray(d.processedMids)) d.processedMids = [];
  if (!d.fingerprints || typeof d.fingerprints !== 'object') d.fingerprints = {};
  // 暂存去重的账：<来源群号> → <指纹8位> → 上一次暂存的时刻
  if (!d.stagedFp || typeof d.stagedFp !== 'object') d.stagedFp = {};
  if (!d.failures || typeof d.failures !== 'object') d.failures = {};
  if (!d.scannedFiles || typeof d.scannedFiles !== 'object') d.scannedFiles = {};
  if (!d.groupNames || typeof d.groupNames !== 'object') d.groupNames = {};
  // 兜底拉取的可见性状态（C 方案：静默失败要有声音）
  if (!d.historyState || typeof d.historyState !== 'object') d.historyState = {};
  if (!d.noArchiveWarnAt || typeof d.noArchiveWarnAt !== 'object') d.noArchiveWarnAt = {};
  if (!Number(d.lastFailNotifyAt)) d.lastFailNotifyAt = 0;
  if (!Number(d.selfId)) d.selfId = 0;
  if (!d.dayKey) d.dayKey = dayKeyOf();
  midSet = new Set(d.processedMids.map(String));
  nameCache.clear();
  for (const [gid, v] of Object.entries(d.groupNames)) {
    const nm = normName(v);
    if (nm) nameCache.set(String(gid), { name: nm, at: Number(v?.at) || 0 });
  }
}

/**
 * 本地日期键（YYYY-MM-DD）—— 暂存编号「每天重置」靠它判断跨天。
 * 用本地时区：主人看的日志/时间都是本地时间，跨天当然也按本地 0 点算。
 */
function dayKeyOf(ts = now()) {
  const d = new Date(Number(ts) || Date.now());
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/**
 * 跨天就把暂存编号从 1 重新开始（主人 2026-10-04：每天重置序号）。
 * 起手先跳过还活着的暂存已经占掉的号，免得跨天瞬间撞号（`\转发 1` 指哪条都说不清）。
 */
function ensureDayKey() {
  const d = st?.data;
  if (!d) return dayKeyOf();
  const key = dayKeyOf();
  if (d.dayKey === key) return key;
  const prev = d.dayKey || '（首次）';
  const used = new Set(livePending().map((it) => Number(it.id)));
  let n = 1;
  while (used.has(n)) n += 1;
  d.dayKey = key;
  d.nextId = n;
  st.touch(0);
  log(`新的一天（${prev} → ${key}），暂存编号从 ${n} 重新开始`);
  return key;
}

/** 武装：记下"从这一刻起才处理"的时间点（只记一次）。 */
function arm(s = settings()) {
  if (Number(st.data.armedAt)) return Number(st.data.armedAt);
  st.data.armedAt = now();
  st.touch(0);
  log(`已武装：只处理 ${new Date(Number(st.data.armedAt)).toLocaleString('zh-CN', { hour12: false })} 之后的合并转发`
    + `（armedPolicy=${s.armedPolicy === 'all' ? 'all：连历史一起处理' : 'new-only'}）`);
  return Number(st.data.armedAt);
}

function markProcessed(mid) {
  const m = String(mid ?? '');
  if (!m) return;
  const d = st.data;
  if (!midSet.has(m)) {
    midSet.add(m);
    if (!Array.isArray(d.processedMids)) d.processedMids = [];
    d.processedMids.push(m);
    while (d.processedMids.length > MAX_PROCESSED) d.processedMids.shift();
  }
  st.touch();
}

function bumpFailure(mid, reason) {
  const d = st.data;
  const k = String(mid);
  const prev = d.failures[k];
  d.failures[k] = { count: (Number(prev?.count) || 0) + 1, ts: now(), reason: String(reason || '').slice(0, 200) };
  st.touch();
}

function pushDone(rec) {
  const d = st.data;
  if (!Array.isArray(d.done)) d.done = [];
  d.done.push(rec);
  while (d.done.length > MAX_DONE) d.done.shift();
}

/* ══════════════════════════════════════════════════════════════════════
   指纹索引 / 存档
   ══════════════════════════════════════════════════════════════════════ */

function fpMap(groupId, create = false) {
  const d = st.data;
  if (!d.fingerprints || typeof d.fingerprints !== 'object') d.fingerprints = {};
  if (!d.fingerprints[groupId] || typeof d.fingerprints[groupId] !== 'object') {
    if (!create) return null;
    d.fingerprints[groupId] = {};
  }
  return d.fingerprints[groupId];
}

function hasFingerprint(groupId, f8) {
  const map = fpMap(groupId, false);
  return !!(map && map[f8]);
}

/** true = 该转发（这个导向群还没有同一条内容）。判定口径就是这一个函数，别在别处再写一遍。 */
function shouldRelay(f8, groupId) {
  return !hasFingerprint(groupId, f8);
}

function registerFingerprint(groupId, f8, ts) {
  if (!groupId || !f8) return;
  fpMap(groupId, true)[f8] = Number(ts) || now();
  st.touch();
}

/* ── 暂存去重（主人 2026-10-04 点名要的）──────────────────────────────
   问题现场：同一份转发（同指纹 77528dd6 的 37 条）被反复当成"新转发"暂存 ——
   兜底拉取（get_group_msg_history）每轮回来的 message_id 会变，mid 去重认不住它，
   于是主人被同一份内容问了一次又一次（#9 他亲手 \不转 掉，39 秒后 #10 又是它）。
   口径：**按内容指纹认，不按 mid**。还挂在暂存里的重复 → 无条件跳过；
   已经处理过的（丢掉/超时/转出去）→ dedupeHours 窗口内也跳过。
   ─────────────────────────────────────────────────────────────────── */

function stagedFpMap(groupId, create = false) {
  const d = st.data;
  if (!d.stagedFp || typeof d.stagedFp !== 'object') d.stagedFp = {};
  if (!d.stagedFp[groupId] || typeof d.stagedFp[groupId] !== 'object') {
    if (!create) return null;
    d.stagedFp[groupId] = {};
  }
  return d.stagedFp[groupId];
}

/** 这份内容上次被暂存是什么时候（过了 dedupeHours 窗口就当没见过，返回 0）。 */
function stagedFpAt(groupId, f8) {
  const ts = Number(stagedFpMap(groupId, false)?.[f8]) || 0;
  if (!ts) return 0;
  const hours = Number(settings().dedupeHours) || 0;
  if (hours > 0 && now() - ts > hours * 3600e3) return 0;
  return ts;
}

function markStagedFp(groupId, f8, ts) {
  if (!groupId || !f8) return;
  stagedFpMap(groupId, true)[f8] = Number(ts) || now();
  st.touch();
}

/**
 * 这份内容之前是不是已经暂存过？
 * @returns {null | {kind:'pending'|'settled', id:number, why:string, at:number}}
 */
function stagedBefore(groupId, f8) {
  // 0 = 把去重整个关掉（回到老行为：兜底拉取每轮换 mid，同一份内容会被反复问你）
  if (!(Number(settings().dedupeHours) > 0)) return null;
  const live = livePending().find((it) => it?.fp8 === f8 && String(it.srcGroup) === String(groupId));
  if (live) return { kind: 'pending', id: Number(live.id) || 0, why: '', at: Number(live.at) || 0 };
  const ts = stagedFpAt(groupId, f8);
  if (!ts) return null;
  const rows = Array.isArray(st.data.done) ? st.data.done : [];
  const last = [...rows].reverse().find((x) => x?.fp8 === f8);
  return { kind: 'settled', id: Number(last?.id) || 0, why: String(last?.why || ''), at: ts };
}

/** 丢掉过了窗口的去重账（顺便把账本大小压住）。 */
function pruneStagedFp(s = settings()) {
  const d = st?.data;
  if (!d?.stagedFp || typeof d.stagedFp !== 'object') return 0;
  const keepMs = Math.max(Number(s.dedupeHours) || 0, 24) * 3600e3;
  const t = now();
  let removed = 0;
  for (const [gid, map] of Object.entries(d.stagedFp)) {
    if (!map || typeof map !== 'object') { delete d.stagedFp[gid]; continue; }
    for (const [f8, ts] of Object.entries(map)) {
      if (!(Number(ts) > 0) || t - Number(ts) > keepMs) { delete map[f8]; removed += 1; }
    }
    if (!Object.keys(map).length) delete d.stagedFp[gid];
  }
  if (removed) st.touch();
  return removed;
}

/** 去重账本里记了多少份内容（状态页给主人看的数）。 */
function countStagedFp() {
  const d = st?.data;
  if (!d?.stagedFp || typeof d.stagedFp !== 'object') return 0;
  let n = 0;
  for (const map of Object.values(d.stagedFp)) if (map && typeof map === 'object') n += Object.keys(map).length;
  return n;
}

const WHY_TEXT = {
  'owner-drop': '你已经说不要',
  'owner-timeout': '超时自动丢掉',
  confirm: '你已经确认转发',
  sent: '已经转出去了'
};

/** 写一份存档到 `.../<群号>/<日期>_<指纹8位>.md`，返回文件路径（失败返回空串）。 */
function writeArchive({ groupId, item, status }) {
  try {
    const dir = groupDir(groupId);
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${mods.core.stampOf(item.at)}_${item.fp8}.md`);
    const body = mods.core.renderArchive({
      at: item.at,
      srcGroup: item.srcGroup,
      srcGroupName: item.srcGroupName,
      senderName: item.senderName,
      senderId: item.senderId,
      count: item.count,
      mid: item.mid,
      fp: item.fp,
      status: mods.core.statusLabel(status),
      via: item.via,
      degraded: item.degraded,
      truncated: item.truncated,
      body: item.text
    });
    fs.writeFileSync(file, body, 'utf8');
    return file;
  } catch (error) {
    warn(`存档写盘失败（群 ${groupId}）：${error?.message ?? error}`);
    return '';
  }
}

function setArchiveStatus(file, status) {
  try {
    if (!file || !fs.existsSync(file)) return;
    const text = fs.readFileSync(file, 'utf8');
    fs.writeFileSync(file, mods.core.replaceArchiveStatus(text, mods.core.statusLabel(status)), 'utf8');
  } catch (error) {
    warn(`存档状态更新失败：${error?.message ?? error}`);
  }
}

/** 统计存档文件数（只看数字目录名，别把无关目录算进来）。 */
function archiveStats() {
  const out = { groups: 0, files: 0 };
  try {
    const root = archiveRoot();
    for (const name of fs.readdirSync(root)) {
      if (!/^\d{5,12}$/.test(name)) continue;
      try {
        const files = fs.readdirSync(path.join(root, name)).filter((f) => f.endsWith('.md'));
        if (!files.length) continue;
        out.groups += 1;
        out.files += files.length;
      } catch { /* 单个目录读不动就算了 */ }
    }
  } catch { /* 根目录还不存在 = 0 */ }
  return out;
}

function countFingerprints() {
  let n = 0;
  const maps = st?.data?.fingerprints;
  if (maps && typeof maps === 'object') {
    for (const m of Object.values(maps)) if (m && typeof m === 'object') n += Object.keys(m).length;
  }
  return n;
}

/* ══════════════════════════════════════════════════════════════════════
   OneBot HTTP（定时器里没有消息上下文，只能直接打 HTTP 口）
   ══════════════════════════════════════════════════════════════════════
   为什么不用 ctx.onebot：扫描是定时器/hook 触发的，很多时刻根本没有 ctx。
   这条口是 SnowLuma 的本地 HTTP API（qq-file-intake / group-reports 都在用）。
   ⚠️ api.fetch 只有在清单声明了 web_fetch 权限时**才等于 globalThis.fetch**，
   否则是个"身份不同"的 reject 桩。所以判断不能写成 `apiRef.fetch !== globalThis.fetch`
   —— 那个条件在没声明权限时**正好挑中桩**，真机上表现为
   `未声明 web_fetch 权限` 把整条链路打死（2026-10-04 踩过，插件已补 permissions）。
   这里的口径改成：能用全局 fetch 就用全局，全局没有才退回 api.fetch。 */

let callOverride = null;

function onebotEndpoint() {
  let cfg = null;
  try { cfg = getConfig(); } catch { /* 读不到就用默认本地口 */ }
  const httpUrl = String(cfg?.snowluma?.httpUrl || 'http://127.0.0.1:3000').replace(/\/+$/, '');
  const token = String(cfg?.snowluma?.httpAccessToken || cfg?.snowluma?.accessToken || '');
  return { httpUrl, token };
}

async function onebotCall(action, params = {}, timeoutMs = 10000) {
  const { httpUrl, token } = onebotEndpoint();
  const doFetch = (typeof globalThis.fetch === 'function')
    ? globalThis.fetch
    : (apiRef && typeof apiRef.fetch === 'function' ? apiRef.fetch : null);
  if (!doFetch) throw new Error(`OneBot ${action} 失败：环境里没有可用的 fetch`);
  const res = await doFetch(`${httpUrl}/${action}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {})
    },
    body: JSON.stringify(params),
    signal: AbortSignal.timeout(timeoutMs)
  });
  if (!res.ok) throw new Error(`OneBot ${action} HTTP ${res.status}`);
  const body = await res.json().catch(() => ({}));
  if (body.status !== 'ok' && body.retcode !== 0) {
    throw new Error(`OneBot ${action} 失败：retcode=${body.retcode ?? body.status} ${body.wording ?? ''}`);
  }
  return body.data;
}

function callOnebot(action, params, timeoutMs) {
  if (typeof callOverride === 'function') return callOverride(action, params, timeoutMs);
  return onebotCall(action, params, timeoutMs);
}

/* ══════════════════════════════════════════════════════════════════════
   群名（询问 / 回执里要**写出来**，不能只给群号）
   ══════════════════════════════════════════════════════════════════════
   主人 2026-10-04：询问和回执主要写群名称，群号只当备注 —— 一串数字认不出是哪个群。
   来源就是 `get_group_info`（SnowLuma 本地 HTTP 口，和发消息同一条通路），
   结果缓存在 `state.groupNames` 里，默认 12 小时才回源一次：群名不会天天改，
   而询问/回执在扫描热路径上，不该每次都打一次 HTTP。
   ⚠️ SnowLuma 自己给的名字就可能是截断过的（例：`某某群、Abc Def G...`），
   它给什么就显示什么，插件不许自己猜/补全。
   永不抛错：取不到名字只是回执里少个名字，绝不能影响转发本身。 */

const GROUP_NAME_TTL_MS = 12 * 3600 * 1000;
const GROUP_NAME_TIMEOUT_MS = 8000;
const nameCache = new Map();     // gid -> { name, at }

function normName(v) {
  return String(typeof v === 'string' ? v : (v?.name ?? '')).trim();
}

/** 群名（不知道就是空串）。内存缓存 → state.groupNames → 空。 */
function groupNameOf(groupId) {
  const gid = String(groupId ?? '').trim();
  if (!gid) return '';
  const hit = nameCache.get(gid);
  if (hit?.name) return hit.name;
  const saved = st?.data?.groupNames?.[gid];
  const nm = normName(saved);
  if (nm) {
    nameCache.set(gid, { name: nm, at: Number(saved?.at) || 0 });
    return nm;
  }
  return '';
}

/** 群标签：有名字写「群名（群号）」，没名字只写群号。询问/回执/日志统一用它。 */
function labelOf(groupId) {
  const gid = String(groupId ?? '').trim();
  if (!gid) return '';
  return mods ? mods.core.groupLabel(gid, groupNameOf(gid)) : gid;
}

/** 一批群号 → 「群名（群号）」并用「、」连起来（receipt 里最常用）。 */
function labelList(list) {
  const arr = (Array.isArray(list) ? list : []).map((x) => String(x ?? '').trim()).filter(Boolean);
  return arr.length ? arr.map(labelOf).join('、') : '（无）';
}

function saveGroupName(gid, name) {
  const nm = String(name ?? '').trim();
  if (!nm) return;
  const at = now();
  nameCache.set(gid, { name: nm, at });
  const d = st?.data;
  if (!d) return;
  if (!d.groupNames || typeof d.groupNames !== 'object') d.groupNames = {};
  d.groupNames[gid] = { name: nm, at };
  st.touch(400);
}

/**
 * 解析一批群名（缓存还新鲜就跳过 —— 命中缓存时零 HTTP）。
 * @returns {Promise<Record<string,string>>} 群号 → 名字（取不到就是空串）
 */
async function resolveGroupNames(ids, { force = false, timeoutMs = GROUP_NAME_TIMEOUT_MS } = {}) {
  const want = [...new Set((Array.isArray(ids) ? ids : [])
    .map((x) => String(x ?? '').trim())
    .filter((x) => /^\d{5,12}$/.test(x)))];
  const out = {};
  for (const gid of want) out[gid] = groupNameOf(gid);
  if (!want.length) return out;
  try { await boot(); } catch { /* 状态还没起来就只用已有的名字 */ }
  // 并行查（一个群查不到不该拖慢其余群；\转发状态 是主人等着看的，最坏也就等一个超时）
  await Promise.all(want.map(async (gid) => {
    const hit = nameCache.get(gid);
    if (!force && hit?.name && (now() - Number(hit.at || 0)) < GROUP_NAME_TTL_MS) return;
    try {
      const data = await callOnebot('get_group_info', { group_id: Number(gid) }, timeoutMs);
      const nm = String(data?.group_name ?? '').trim();
      if (nm) { saveGroupName(gid, nm); out[gid] = nm; }
      else warn(`群 ${gid} 的 get_group_info 没有返回 group_name`);
    } catch (error) {
      warn(`取群名失败（${gid}）：${error?.message ?? error}`);
    }
  }));
  return out;
}

/** 当前配置里所有涉及的群（注入群 + 导向群），用于批量解析名字。 */
function configuredGroups(s = settings()) {
  return [...gids(s.injectGroups), ...gids(s.targetGroups)];
}

/* ══════════════════════════════════════════════════════════════════════
   主人 / 私聊
   ══════════════════════════════════════════════════════════════════════ */

/** 主人判定：只认能力协议（正文里自称"我是主人"没有用）。 */
function isOwnerId(userId) {
  const id = String(userId ?? '').trim();
  if (!id) return false;
  try {
    return apiRef?.capability?.('message.owner-check', { userId: id })?.isOwner === true;
  } catch {
    return false;
  }
}

/** 私聊目标：插件设置 askTo → owner-identity.ids → group-reports.ownerQq（三处都空就只写日志）。 */
function ownerTarget() {
  const s = settings();
  const explicit = ownerIds(s.askTo);
  if (explicit.length) return { id: explicit[0], from: '插件设置 askTo' };
  let cfg = null;
  try { cfg = getConfig(); } catch { /* 走兜底 */ }
  const ids = ownerIds(cfg?.skills?.['owner-identity']?.ids);
  if (ids.length) return { id: ids[0], from: 'owner-identity' };
  const fb = ownerIds(cfg?.skills?.['group-reports']?.ownerQq);
  if (fb.length) return { id: fb[0], from: 'group-reports' };
  return { id: '', from: '' };
}

/**
 * 给主人发私聊。
 * 硬规则（主人 2026-10-05 追加）：测试/询问/告知/告警**一律私聊**，绝不发群。
 * 所有"通知类"消息都必须走这个函数 —— 只有真正的转发任务才调用 sendForwardTo。
 */
async function notifyOwner(text, why = '') {
  const body = String(text ?? '');
  if (!body.trim()) return { ok: false, error: '空消息' };
  const to = ownerTarget();
  if (!to.id) {
    warn(`没有可用的主人 QQ（${why || '通知'}），只写日志：${body.split('\n')[0]}`);
    return { ok: false, error: '找不到主人 QQ' };
  }
  try {
    const raw = await callOnebot('send_private_msg', { user_id: Number(to.id), message: body }, 15000);
    log(`已私聊主人（${to.from}）${why ? `· ${why}` : ''}：${body.split('\n')[0]}`);
    return { ok: true, to: to.id, raw };
  } catch (error) {
    warn(`私聊主人失败（${why}）：${error?.message ?? error}`);
    return { ok: false, error: error?.message ?? String(error) };
  }
}

/* ══════════════════════════════════════════════════════════════════════
   发送（合并转发优先，失败回退纯文本）
   ══════════════════════════════════════════════════════════════════════ */

const SEND_ACTIONS = {
  group: { forward: 'send_group_forward_msg', text: 'send_group_msg', idField: 'group_id' },
  private: { forward: 'send_private_forward_msg', text: 'send_private_msg', idField: 'user_id' }
};

/**
 * 把一条暂存的转发发到某个群（或私聊某人）。
 *
 * 先试合并转发（重组节点），失败按 textFallback 回退纯文本。
 * @returns {{ok:boolean, method?:'forward'|'text', error?:string, target:string, targetName:string, raw?:any}}
 */
async function sendForwardTo(kind, targetId, item, { targetName = '' } = {}) {
  const s = settings();
  const act = SEND_ACTIONS[kind] || SEND_ACTIONS.group;
  const id = String(targetId);
  const numeric = Number(id);
  const rateKey = `${kind}:${id}`;
  const gap = now() - (lastSendAt.get(rateKey) || 0);
  if (gap < SEND_MIN_GAP_MS) await sleep(SEND_MIN_GAP_MS - gap);   // 限速：同目标 1 秒不重复发

  const messages = Array.isArray(item?.nodes) ? item.nodes : [];
  let forwardError = '';
  if (messages.length) {
    try {
      const raw = await callOnebot(act.forward, { [act.idField]: numeric, messages }, 20000);
      lastSendAt.set(rateKey, now());
      return { ok: true, method: 'forward', target: id, targetName, raw };
    } catch (error) {
      forwardError = error?.message ?? String(error);
    }
  } else {
    forwardError = '没有可用的节点（get_forward_msg 没取到原始节点）';
  }

  if (!s.textFallback) {
    return { ok: false, error: forwardError, target: id, targetName };
  }
  try {
    const raw = await callOnebot(act.text, { [act.idField]: numeric, message: String(item?.text ?? '') }, 20000);
    lastSendAt.set(rateKey, now());
    return { ok: true, method: 'text', error: forwardError, target: id, targetName, raw };
  } catch (error) {
    lastSendAt.set(rateKey, now());
    return {
      ok: false,
      target: id,
      targetName,
      error: `合并转发失败：${forwardError}；纯文本也失败：${error?.message ?? error}`
    };
  }
}

/**
 * 「原文先发一份」：把暂存的**原始合并转发**直接私聊给主人。
 *
 * 起因（主人 2026-10-05）：「能不能让薄荷直接把原始的合并消息转给主人，不然还是不直观」
 * —— 纯文字预览看不出上下文，所以扫描时先把重组后的合并转发卡片发到主人私聊，
 * 主人点开就是原文；随后的那条询问文案只负责报编号和口令。
 *
 * 约束：只发主人私聊（绝不发群）；同一条推过就不再推（`item.pushedAt`）；
 * 一轮最多 `s.maxPushPerScan` 条，剩下的留在暂存里（编号与来源都能用 `\转发状态` 看）。
 *
 * @returns {{ok:boolean, sent:number, failed:number, already:number, pending:number}}
 */
async function pushOriginalsToOwner(items, s, why = '原文') {
  const out = { ok: false, sent: 0, failed: 0, already: 0, pending: 0 };
  if (!s?.pushOriginal) return out;
  const list = Array.isArray(items) ? items.filter(Boolean) : [];
  if (!list.length) return out;
  const to = ownerTarget();
  if (!to.id) {
    warn(`没有可用的主人 QQ（${why}），${list.length} 条原文推不出去`);
    return out;
  }
  const queue = list.filter((it) => !Number(it.pushedAt));
  out.already = list.length - queue.length;
  const limit = Math.max(1, Math.min(queue.length, Number(s.maxPushPerScan) || DEFAULTS.maxPushPerScan));
  const picked = queue.slice(0, limit);
  out.pending = queue.length - picked.length;
  for (const it of picked) {
    if (!st) return out;   // 热重载中途作废，别再往下发
    const r = await sendForwardTo('private', to.id, it, { targetName: '主人私聊' });
    if (r.ok) {
      out.sent += 1;
      it.pushedAt = now();
      it.pushedMethod = r.method;
    } else {
      out.failed += 1;
      warn(`推原文失败（#${it.id}）：${r.error}`);
    }
  }
  const okIds = picked.filter((x) => Number(x.pushedAt)).map((x) => x.id);
  if (out.sent) {
    log(`${why}：已把 ${out.sent} 条原始合并转发私聊给主人（编号 ${okIds.join('、')}${out.pending ? `，另有 ${out.pending} 条本轮没推` : ''}）`);
  }
  out.ok = out.sent > 0;
  return out;
}

/* ══════════════════════════════════════════════════════════════════════
   发现（扫描聊天存档）
   ══════════════════════════════════════════════════════════════════════ */

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  } catch {
    return null;
  }
}

/**
 * 核心 `src/onebot.js` 的 expandForwardNodes —— 和 ingest 用同一份实现，保证正文口径一致。
 *
 * 为什么用动态 import：插件被自测脚本单独加载时，src/onebot.js 会连带拉起 ws /
 * 技能管理器，单跑 node 未必解析得动。拿不到就退回 lib/core.js 里的等价实现
 * （只有正文排版的口径要求，指纹判定在同一进程里始终一致）。
 */
let expandImpl = null;
let expandLoadFailed = false;
async function expandNodes(nodes, opts) {
  if (!expandImpl && !expandLoadFailed) {
    try {
      const m = await import('../../src/onebot.js');
      expandImpl = typeof m.expandForwardNodes === 'function' ? m.expandForwardNodes : null;
      if (!expandImpl) expandLoadFailed = true;
    } catch (error) {
      expandLoadFailed = true;
      warn(`核心 expandForwardNodes 加载失败，改用本地等价实现：${error?.message ?? error}`);
    }
  }
  const fn = expandImpl || mods.core.expandNodesLocal;
  return fn(nodes, opts);
}

/**
 * 拿一条转发的真节点：先 message_id（主路径，父会话真机验证过），
 * 失败再试 res_id（`[CQ:forward,id=…]`，也是验证过的第二兜底）。
 */
async function fetchNodes(mid, resId) {
  const tries = [];
  tries.push({ via: 'message_id', params: { message_id: /^-?\d+$/.test(mid) ? Number(mid) : mid } });
  if (resId) tries.push({ via: 'res_id', params: { id: resId } });
  let error = '';
  for (const t of tries) {
    try {
      const r = await callOnebot('get_forward_msg', t.params, 15000);
      const nodes = Array.isArray(r?.messages)
        ? r.messages
        : (Array.isArray(r?.data?.messages) ? r.data.messages : []);
      if (nodes.length) return { nodes, via: t.via };
      error = '返回里没有 messages';
    } catch (e) {
      error = e?.message ?? String(e);
    }
  }
  return { nodes: [], error };
}

/* ══════════════════════════════════════════════════════════════════════
   兜底拉取（A）+ 静默失败可见（C）
   ══════════════════════════════════════════════════════════════════════ */

const NO_ARCHIVE_WARN_GAP_MS = 30 * 60000;   // 同一个群「核心没存档」的抱怨：30 分钟最多一次
const GIVE_UP_NOTIFY_GAP_MS = 10 * 60000;     // 「取不到内容已放弃」的私聊：10 分钟最多一次

const coreArchiveFile = (gid) => path.join(DATA_DIR, 'messages', `group_${gid}.json`);

/** 核心给这个群写聊天存档了吗？（白名单 allow.groups 之外的群一律没有） */
function hasCoreArchive(gid) {
  try { fs.statSync(coreArchiveFile(gid)); return true; } catch { return false; }
}

/** OneBot 的一条群消息 → store 里那种条目（键名对齐，handleEntry 才吃得下）。 */
function entryFromOnebot(m, selfId = 0) {
  const mid = String(m?.message_id ?? '').trim();
  if (!mid) return null;
  const uid = String(m?.sender?.user_id ?? m?.user_id ?? '');
  if (selfId && uid && uid === String(selfId)) return { self: true };   // 薄荷自己发的不转
  const segs = Array.isArray(m?.message) ? m.message : [];
  const parts = [];
  let hasForward = false;
  let resId = '';
  for (const sg of segs) {
    const t = String(sg?.type ?? '');
    if (t === 'text') parts.push(String(sg?.data?.text ?? ''));
    else if (t === 'forward') { hasForward = true; resId = resId || String(sg?.data?.id ?? ''); }
    else if (t === 'image') parts.push('[图片]');
    else if (t === 'at') parts.push(`@${sg?.data?.qq ?? ''}`);
  }
  const raw = String(m?.raw_message ?? '');
  const cq = raw.match(/\[CQ:forward,id=([^\]]+)\]/);
  if (cq) { hasForward = true; resId = resId || cq[1]; }
  let text = parts.join('').trim();
  // 占位符 + CQ 码一起给：既过 looksLikeForward，又能让 extractForwardResId 抠到 res_id
  if (hasForward) text = `[合并转发聊天记录]${resId ? `[CQ:forward,id=${resId}]` : ''}`;
  return {
    id: 0,
    mid,
    ts: (Number(m?.time) || 0) * 1000,          // OneBot 的 time 是秒
    senderId: uid,
    senderName: String(m?.sender?.card || m?.sender?.nickname || uid || '').slice(0, 40),
    text,
    self: false,
    read: true,
    via: 'history'
  };
}

/** 薄荷自己的 QQ（用来把机器人自己发的转发排掉）；取不到就当 0，不影响后续。 */
async function ensureSelfId() {
  if (Number(st.data.selfId)) return Number(st.data.selfId);
  try {
    const r = await callOnebot('get_login_info', {}, 8000);
    const id = Number(r?.user_id ?? r?.data?.user_id ?? 0);
    if (id) { st.data.selfId = id; st.touch(0); }
    return id;
  } catch { return 0; }
}

/**
 * A 方案：注入群没有核心聊天存档（不在 allow.groups 里）时，自己用 OneBot
 * `get_group_msg_history` 只读拉最近 N 条来判定 —— 不改白名单、不唤醒薄荷、不发言。
 */
async function scanHistory(gid, s, fresh, stat) {
  const count = Math.max(5, Math.min(200, Number(s.historyCount) || DEFAULTS.historyCount));
  const putState = (patch) => {
    const d = st.data;
    if (!d.historyState || typeof d.historyState !== 'object') d.historyState = {};
    d.historyState[String(gid)] = { at: now(), count, ...patch };
    st.touch(0);
  };
  let data;
  try {
    data = await callOnebot('get_group_msg_history', { group_id: Number(gid), count }, 15000);
  } catch (error) {
    const err = String(error?.message ?? error).slice(0, 200);
    putState({ ok: false, error: err, got: 0, forwards: 0 });
    return { ok: false, error: err };
  }
  const list = Array.isArray(data) ? data : (Array.isArray(data?.messages) ? data.messages : []);
  const selfId = await ensureSelfId();
  let forwards = 0;
  for (const m of list) {
    const e = entryFromOnebot(m, selfId);
    if (!e) continue;
    const r = await handleEntry(gid, e, s, fresh);
    if (r === 'forward') { forwards += 1; stat.forwards += 1; }
    else if (r === 'stale') stat.stale += 1;
  }
  putState({ ok: true, error: '', got: list.length, forwards });
  if (forwards) log(`兜底拉取 ${labelOf(gid)}：最近 ${list.length} 条里认出 ${forwards} 条新转发`);
  return { ok: true, got: list.length, forwards };
}

/** C 方案：注入群没有核心存档这件事，别一声不吭（同一个群 30 分钟最多抱怨一次）。 */
function warnNoArchive(gid, s, why = '') {
  const d = st.data;
  if (!d.noArchiveWarnAt || typeof d.noArchiveWarnAt !== 'object') d.noArchiveWarnAt = {};
  const key = String(gid);
  if (now() - (Number(d.noArchiveWarnAt[key]) || 0) < NO_ARCHIVE_WARN_GAP_MS) return false;
  d.noArchiveWarnAt[key] = now();
  st.touch(0);
  const detail = s.historyFallback
    ? `核心没给这个群写聊天存档（不在 allow.groups 里），已改用 OneBot 历史兜底`
      + `${why ? `，但这轮兜底也没拉成功：${why}` : ''}`
    : '核心没给这个群写聊天存档（不在 allow.groups 里），而兜底拉取（historyFallback）关着 —— 插件看不到它的任何消息';
  warn(`注入群 ${labelOf(gid)}：${detail}`);
  return true;
}

/** C 方案：转发展开重试 3 次仍然拿不到 → 私聊主人说一声（10 分钟最多一次）。 */
async function notifyGiveUp(groupId, e, reason) {
  const d = st.data;
  const gapMin = Math.round(GIVE_UP_NOTIFY_GAP_MS / 60000);
  if (now() - (Number(d.lastFailNotifyAt) || 0) < GIVE_UP_NOTIFY_GAP_MS) {
    log(`取不到内容的转发已放弃（${gapMin} 分钟内不再私聊打扰）：群 ${groupId} · mid=${e?.mid ?? '?'}`);
    return false;
  }
  const when = Number(e?.ts) ? mods.core.humanTime(Number(e.ts)) : mods.core.humanTime(now());
  const text = [
    '⚠️ 屎壳郎：有一条合并转发取不到内容，已放弃',
    `来源 ${labelOf(groupId)} · ${e?.senderName || '未知'}(${e?.senderId || '?'}) · ${when}`,
    `原因：${String(reason || '未知原因').slice(0, 160)}`,
    `（重试 ${MAX_FETCH_RETRY} 次都拿不到，一般是转发内容为空或已被撤回；后面再有取不到的先只记日志，${gapMin} 分钟内不再私聊）`
  ].join('\n');
  const r = await notifyOwner(text, '取不到内容的转发（放弃）');
  if (r.ok) { d.lastFailNotifyAt = now(); st.touch(); }
  return r.ok === true;
}

function prunePending() {
  const d = st.data;
  if (!Array.isArray(d.pending) || !d.pending.length) return 0;
  const t = now();
  const kept = [];
  let dropped = 0;
  for (const it of d.pending) {
    if (!it || (Number(it.expiresAt) > 0 && Number(it.expiresAt) <= t)) { dropped += 1; continue; }
    kept.push(it);
  }
  if (dropped) {
    d.pending = kept;
    st.touch();
    log(`丢掉 ${dropped} 条过期暂存（超过 ttlHours=${settings().ttlHours}）`);
  }
  return dropped;
}

/** 还没过期、还活着的暂存。 */
function livePending() {
  const list = Array.isArray(st?.data?.pending) ? st.data.pending : [];
  const t = now();
  return list.filter((it) => it && !(Number(it.expiresAt) > 0 && Number(it.expiresAt) <= t));
}

function findPending(id) {
  const items = livePending();
  if (!items.length) return null;
  if (!id) return items[items.length - 1];
  return items.find((i) => Number(i.id) === Number(id)) || null;
}

function dropFromPending(id, status, why) {
  const d = st.data;
  if (!Array.isArray(d.pending)) return null;
  const idx = d.pending.findIndex((i) => Number(i?.id) === Number(id));
  if (idx < 0) return null;
  const [item] = d.pending.splice(idx, 1);
  pushDone({ id: item.id, fp8: item.fp8, at: now(), status, why: String(why || ''), targets: item.targets || [] });
  st.touch();
  return item;
}

/**
 * 处理 store 里的一条消息。
 * @returns {''|'forward'|'stale'} forward = 真的处理了一条合并转发
 */
async function handleEntry(groupId, e, s, fresh) {
  if (!e || typeof e !== 'object' || e.self) return '';
  const text = String(e.text ?? '');
  if (!mods.core.looksLikeForward(text)) return '';
  const mid = String(e.mid ?? '').trim();
  if (!mid) return '';                                   // 没有 mid 就取不到节点，连占位符都救不了
  if (midSet.has(mid)) return '';
  const fails = Number(st.data.failures?.[mid]?.count) || 0;
  if (fails >= MAX_FETCH_RETRY) return '';
  const ts = Number(e.ts) || 0;
  if (s.armedPolicy !== 'all' && ts && ts < Number(st.data.armedAt || 0)) return '';

  const resId = mods.core.extractForwardResId(text);
  const got = await fetchNodes(mid, resId);
  if (!got.nodes.length) {
    bumpFailure(mid, got.error);
    const n = Number(st.data.failures?.[mid]?.count) || 0;
    warn(`mid=${mid}（群 ${groupId}）取不到合并转发节点（第 ${n}/${MAX_FETCH_RETRY} 次）：${got.error || '未知原因'}`);
    if (n >= MAX_FETCH_RETRY) {
      markProcessed(mid);                                 // 放弃重试，别再刷日志
      await notifyGiveUp(groupId, e, got.error);           // C：放弃也要让主人看见（不再静默）
    }
    return 'stale';
  }

  const ex = await expandNodes(got.nodes, { maxNodes: mods.core.MAX_NODES, maxChars: mods.core.MAX_TEXT_CHARS });
  const body = (ex && ex.text) ? ex.text : `[合并转发 共${got.nodes.length}条]`;
  const fp = mods.core.fingerprint(body);
  const f8 = mods.core.fp8(fp);
  // 暂存去重：同一份内容只问主人一次（按指纹认，不看 mid —— 兜底拉取的 mid 每轮都会变）
  const dup = stagedBefore(groupId, f8);
  if (dup) {
    markProcessed(mid);
    if (dup.kind === 'pending') {
      log(`↻ 暂存去重：这份内容（指纹 ${f8}）已经挂在暂存 #${dup.id} 等你拍板了，不再重复问一遍`);
    } else {
      const why = WHY_TEXT[dup.why] || `已处理（${dup.why || '未知原因'}）`;
      const mins = Math.max(0, Math.round((now() - dup.at) / 60000));
      log(`↻ 暂存去重：这份内容（指纹 ${f8}）${mins} 分钟前就暂存过`
        + `${dup.id ? `（#${dup.id}）` : ''} —— ${why}，${settings().dedupeHours} 小时窗口内不再重复问你`);
    }
    return 'dup';
  }
  const rebuilt = mods.core.rebuildNodes(got.nodes);
  const at = now();
  const item = {
    id: Number(st.data.nextId) || 1,
    fp,
    fp8: f8,
    srcGroup: String(groupId),
    srcGroupName: groupNameOf(groupId),
    senderId: String(e.senderId ?? '').slice(0, 20),
    senderName: String(e.senderName ?? '').slice(0, 40),
    count: got.nodes.length,
    mid,
    via: got.via,
    text: body,
    nodes: rebuilt.messages,
    degraded: rebuilt.degraded,
    truncated: rebuilt.truncated || /…（还有 \d+ 条未展开）/.test(body),
    at,
    expiresAt: at + Math.max(0, Number(s.ttlHours) || 0) * 3600e3,
    targets: []
  };
  st.data.nextId = item.id + 1;

  const file = writeArchive({ groupId, item, status: 'pending' });
  registerFingerprint(groupId, f8, at);       // 源群自己也算"见过"，避免它同时又是导向群时自转
  markStagedFp(groupId, f8, at);              // 暂存去重的账：这份内容在 dedupeHours 内不再重复问你
  if (rebuilt.truncated) warn(`#${item.id} 节点过多/过长，已截断重发用的节点（原文 ${got.nodes.length} 条）`);

  const allTargets = gids(s.targetGroups);
  const quiet = new Set(gids(s.quietGroups));
  const targets = allTargets.filter((t) => shouldRelay(f8, t));
  const dupes = allTargets.filter((t) => !shouldRelay(f8, t));
  item.targets = targets;
  // 导向群里**已经有**这份内容的，不进备选项（主人 2026-10-04 要求：别把已有这条的群摆出来
  // 让主人白点一次）。但记在条目上：① 询问里能说清"哪些群没列、为什么没列"；
  // ② 主人点名要发这个群时，confirmPending 会先拦一下问他要不要强发。
  item.dupes = dupes;
  markProcessed(mid);

  if (!targets.length) {
    if (file) setArchiveStatus(file, 'archived-only');
    if (!dupes.length || !dupes.every((t) => quiet.has(t))) {
      log(`安静：${groupId} 的这条转发（指纹 ${f8}）在导向群里都已经有了${dupes.length ? `（${dupes.join('、')}）` : ''}`);
    }
    return 'forward';
  }

  const d = st.data;
  if (!Array.isArray(d.pending)) d.pending = [];
  d.pending.push(item);
  while (d.pending.length > MAX_PENDING) {
    const gone = d.pending.shift();
    warn(`待处理超过 ${MAX_PENDING} 条，丢掉最旧的 #${gone?.id}（指纹 ${gone?.fp8}）`);
  }
  fresh.push(item);
  log(`暂存 #${item.id}：群 ${groupId} 的 ${item.count} 条合并转发（指纹 ${f8}）`
    + ` → 候选导向群 ${targets.join('、') || '无'}`);
  return 'forward';
}

/**
 * 扫一遍注入群的聊天存档，发现新的合并转发。
 * 定时器是主路径（薄荷没被触发时钩子不跑），before-context 是"顺手扫一次"。
 */
async function scanOnce(why = 'timer') {
  try {
    const s = settings();
    if (!s.enabled) return { ok: false, reason: '插件已关闭' };
    const injects = gids(s.injectGroups);
    if (!injects.length) return { ok: false, reason: '没有配置注入群' };
    if (scanBusy) return { ok: false, reason: '上一轮扫描还没结束' };
    await boot();
    scanBusy = true;
    try {
      arm(s);
      // 跨天就把暂存编号归 1（每天重置序号）
      ensureDayKey();
      st.data.lastScanAt = now();
      // 群名先备好：询问 / 回执 / 暂存条目都要写群名（命中缓存时零 HTTP，
      // 12 小时才回源一次；取不到就退化成群号，不影响后面的转发判定）。
      await resolveGroupNames(configuredGroups(s));
      // 重载竞态：热重载会在 await 期间把 st 清成 null，这一轮直接作废（别再抛 null.data）
      const alive = () => Boolean(st && st.data);
      if (!alive()) return { ok: false, reason: '插件正在重载，这一轮扫描作废' };
      const fresh = [];
      const stat = { groups: 0, skipped: 0, forwards: 0, stale: 0, fresh: 0, history: 0, noArchive: 0, dup: 0 };
      for (const gid of injects) {
        if (!alive()) return { ok: false, reason: '插件正在重载，这一轮扫描作废' };
        const file = coreArchiveFile(gid);
        let mtimeMs = 0;
        try { mtimeMs = fs.statSync(file).mtimeMs; } catch { mtimeMs = 0; }
        if (!mtimeMs) {
          // 核心没给这个群写存档（不在 allow.groups 里）。旧行为是**静默** continue，
          // 结果就是「注入群填了、插件却永远看不到它的消息」。
          // A：改用 OneBot 历史兜底；C：兜底关着或拉失败时留下声音。
          stat.noArchive += 1;
          if (s.historyFallback) {
            const hr = await scanHistory(gid, s, fresh, stat);
            if (hr.ok) { stat.history += 1; continue; }
            warnNoArchive(gid, s, hr.error);
          } else {
            warnNoArchive(gid, s, '');
          }
          stat.skipped += 1;
          continue;
        }
        // mtime 门控：最大那份群档案 7.6MB，没变过就整份跳过（别每次全 parse）
        if (Number(st.data.scannedFiles?.[file]) === mtimeMs) { stat.skipped += 1; continue; }
        const raw = readJson(file);
        const list = Array.isArray(raw?.messages) ? raw.messages : [];
        stat.groups += 1;
        for (const e of list) {
          const r = await handleEntry(gid, e, s, fresh);
          if (r === 'forward') stat.forwards += 1;
          else if (r === 'stale') stat.stale += 1;
          else if (r === 'dup') { stat.dup += 1; stat.forwards += 1; }
        }
        if (!alive()) return { ok: false, reason: '插件正在重载，这一轮扫描作废' };
        if (!st.data.scannedFiles || typeof st.data.scannedFiles !== 'object') st.data.scannedFiles = {};
        st.data.scannedFiles[file] = mtimeMs;
      }
      st.touch(200);

      stat.fresh = fresh.length;
      let askNotified = false;
      // 「原文先发一份」：新鲜暂存出现时，先把**原始合并转发**私聊给主人（比预览文字直观）。
      // 放在询问之前发，所以询问文案里说的是「上面那条」。
      let pushed = 0;
      // 本轮有没有真的去推过原文（推成功或推失败都算）：补推阶段据此让路，
      // 免得失败的原文本轮被立刻重试两遍、也免得 maxPushPerScan 截断被同轮补齐。
      const triedFresh = Boolean(fresh.length && s.pushOriginal);
      if (triedFresh) {
        const pr = await pushOriginalsToOwner(fresh, s, s.mode === 'ask' ? 'ask 原文' : 'auto 原文');
        pushed = pr.sent;
        if (pushed && alive()) st.touch();
        if (pushed && s.mode !== 'ask') {
          await notifyOwner(
            `📮 屎壳郎 · 上面 ${pushed} 条是刚扫到的原始合并转发`
            + `${pr.failed ? `（另有 ${pr.failed} 条没推成功）` : ''}`
            + '，薄荷会自己判断要不要转（列表：\\转发状态）',
            'auto 原文说明'
          );
        }
      }
      if (fresh.length && s.mode === 'ask') {
        // 一批合成一条私聊（不要一条一发把主人私聊刷爆）
        const gap = now() - (Number(st.data.lastAskAt) || 0);
        if (gap >= 5000) {
          const r = await notifyOwner(mods.core.renderAskText(fresh, s, labelOf, { pushed }), 'ask 询问');
          if (r.ok && alive()) { st.data.lastAskAt = now(); st.touch(); askNotified = true; }
        } else {
          warn(`距上次询问不到 5 秒，这批 ${fresh.length} 条暂存先不私聊（等主人自己看 \\转发状态）`);
        }
      } else if (fresh.length) {
        log(`暂存 ${fresh.length} 条，等薄荷在 auto 模式下判断`);
      }

      prunePending();
      pruneStagedFp(s);
      // 未回复超时：ask 模式下过了 replyTimeoutMin 还没拍板 → 静默丢掉（只写日志，不打扰主人）。
      // 必须先于补推：马上要超时的那条没必要再把原文推一遍。
      if (s.mode === 'ask') await dropTimedOutPending(s);
      // 首推失败、或被 maxPushPerScan 截断的，下一轮顺手补齐原文。
      // ⚠️ 本轮已经去推过（triedFresh）就跳过：否则截断会在同一轮立刻被补齐，maxPushPerScan 形同虚设。
      // 只在 ask 模式补推 —— auto 模式是薄荷自己判断，主人不需要逐条看原文。
      if (s.mode === 'ask' && s.pushOriginal && !triedFresh) {
        const cp = await pushOriginalsToOwner(livePending(), s, 'ask 补推原文');
        if (cp.sent && alive()) st.touch();
      }
      if (alive() && now() - (Number(st.data.lastCleanupAt) || 0) >= s.cleanupIntervalMin * 60000) await cleanup('scan');

      // 回执：20 秒一轮的扫描只在"真有新东西"或"有转发但全是旧的"时留痕，
      // 纯 mtime 门控的空跑一条都不报（否则回执流水会被它刷满）。
      const freshFrom = [...new Set(fresh.map((x) => x.srcGroup))];
      if (stat.fresh > 0) {
        receiptTell({
          plugin: 'forward-relay',
          task: 'scanOnce',
          outcome: 'sent',
          summary: askNotified
            ? `扫到 ${stat.fresh} 条新的合并转发（来自 ${labelList(freshFrom)}），已私聊你等确认`
            : `扫到 ${stat.fresh} 条新的合并转发（来自 ${labelList(freshFrom)}），已暂存等薄荷判断`,
          notifyOwner: askNotified ? false : undefined,
          expectMin: 0
        });
      } else if (stat.forwards > 0) {
        receiptTell({
          plugin: 'forward-relay',
          task: 'scanOnce',
          outcome: 'idle',
          summary: stat.dup > 0
            ? `扫到 ${stat.forwards} 条转发但都已经处理过（其中 ${stat.dup} 条是同一份内容的老面孔，去重挡下了）`
            : `扫到 ${stat.forwards} 条转发但都已经处理过（重复的不会再发）`,
          expectMin: 0
        });
      }

      return { ok: true, why, ...stat, pending: livePending().length, archived: archiveStats().files };
    } finally {
      scanBusy = false;
    }
  } catch (error) {
    // 热重载会把 st 清成 null（fs.watch 风暴下插件被反复重载），这轮扫描直接作废、不算真错误
    if (!st && /Cannot read properties of null/.test(String(error?.message ?? error))) {
      return { ok: false, reason: '插件正在重载，这一轮扫描作废' };
    }
    warn(`扫描出错（${why}）：${error?.message ?? error}`);
    receiptTell({
      plugin: 'forward-relay',
      task: 'scanOnce',
      outcome: 'fail',
      summary: `扫描出错：${error?.message ?? error}`,
      expectMin: 0
    });
    return { ok: false, reason: error?.message ?? String(error) };
  }
}

/* ══════════════════════════════════════════════════════════════════════
   未回复超时（ask 模式）
   ══════════════════════════════════════════════════════════════════════ */

/**
 * 主人没在 `replyTimeoutMin` 分钟内拍板 → **自动丢掉**。
 *
 * 规矩是主人 2026-10-04 定的（原话大意）：「5 分钟内没回复就自动丢弃」。
 *   · 计时从「原文卡片真正送到主人手里」（`item.pushedAt`）算起，没有 pushedAt 才退回扫描时刻（`item.at`）；
 *   · 静默丢弃：**不通知**主人（他选的），只写插件日志 + 存档状态改成 archived-only；
 *   · 存档留着（`\转发状态` 里看不到，但 documents/转发存档 里的 .md 一直都在）；
 *   · `replyTimeoutMin = 0` 可整体关掉（那就回到"一直等"）；
 *   · 只认还挂在 pending 里的几条：`\转发` 发成功 / `\不转` 丢掉的早在 dropFromPending 里移走了。
 */
async function dropTimedOutPending(s) {
  const mins = Number(s?.replyTimeoutMin);
  if (!(mins > 0)) return 0;
  const limit = mins * 60000;
  // 计时起点 = **原文卡片真正送到主人手里**的那一刻（pushedAt），没有才退回扫描到的时刻（at）。
  // 理由：一轮扫到多条时原文是分批推的（maxPushPerScan），最后几张卡片可能比 at 晚好几分钟才到，
  // 按 at 计时会让他刚看到卡片就没时间回；推不出去时退回 at，条目照样会过期、不会永远赖着。
  const since = (it) => Number(it.pushedAt) || Number(it.at) || 0;
  const stale = livePending().filter((it) => !it.sentAt && now() - since(it) >= limit);
  if (!stale.length) return 0;
  const ids = [];
  for (const it of stale) {
    const gone = dropFromPending(it.id, 'archived-only', 'owner-timeout');
    if (!gone) continue;
    ids.push(gone.id);
    log(`⌛ #${gone.id} 超时丢弃：${mins} 分钟没收到主人回复`
      + `（来源群 ${gone.srcGroup} · 发起人 ${gone.senderName || '未知'} · ${gone.count} 条 · 指纹 ${gone.fp8}）`);
  }
  if (!ids.length) return 0;
  receiptTell({
    plugin: 'forward-relay',
    task: 'dropTimedOutPending',
    outcome: 'idle',
    summary: `主人 ${mins} 分钟没回复，超时丢弃 ${ids.length} 条（编号 ${ids.join('、')}）`,
    expectMin: 0
  });
  return ids.length;
}

/* ══════════════════════════════════════════════════════════════════════
   过期清理
   ══════════════════════════════════════════════════════════════════════ */

async function cleanup(why = 'timer') {
  try {
    const s = settings();
    await boot();
    const ttlMs = Math.max(0, Number(s.ttlHours) || 0) * 3600e3;
    const t = now();
    const root = archiveRoot();
    let removedFiles = 0;
    let removedFp = 0;

    let groupNames = [];
    try { groupNames = fs.readdirSync(root).filter((n) => /^\d{5,12}$/.test(n)); } catch { groupNames = []; }

    for (const group of groupNames) {
      const dir = path.join(root, group);
      let files = [];
      try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.md')); } catch { continue; }
      const rows = files
        .map((name) => ({ name, ts: mods.core.parseStampMs(name), fp8: mods.core.fp8OfFile(name) }))
        .sort((a, b) => a.ts - b.ts);
      const keep = Math.max(0, Number(s.maxArchivePerGroup) || 0);
      rows.forEach((row, i) => {
        const tooOld = row.ts > 0 && (t - row.ts) > ttlMs;
        const tooMany = (rows.length - i) > keep;      // 超出上限时留最新的 keep 份
        if (!tooOld && !tooMany) return;
        try { fs.unlinkSync(path.join(dir, row.name)); removedFiles += 1; } catch { /* 删不掉就算了 */ }
        const map = fpMap(group, false);
        if (row.fp8 && map && map[row.fp8] !== undefined) { delete map[row.fp8]; removedFp += 1; }
      });
    }

    // 指纹本身也过期（对应文件可能早就被删了）
    const maps = st.data.fingerprints;
    if (maps && typeof maps === 'object') {
      for (const [group, map] of Object.entries(maps)) {
        if (!map || typeof map !== 'object') continue;
        for (const [f8, ts] of Object.entries(map)) {
          if ((t - (Number(ts) || 0)) > ttlMs) { delete map[f8]; removedFp += 1; }
        }
        if (!Object.keys(map).length) delete maps[group];
      }
    }

    // 取不到节点的失败记录（7 天后忘掉，免得状态文件无限长）
    const fails = st.data.failures;
    if (fails && typeof fails === 'object') {
      for (const [mid, rec] of Object.entries(fails)) {
        if ((t - (Number(rec?.ts) || 0)) > 7 * 24 * 3600e3) delete fails[mid];
      }
    }

    // 已删掉的群档案别一直挂在扫描门控里
    const scanned = st.data.scannedFiles;
    if (scanned && typeof scanned === 'object') {
      for (const file of Object.keys(scanned)) {
        try { if (!fs.existsSync(file)) delete scanned[file]; } catch { /* ignore */ }
      }
    }

    const droppedPending = prunePending();
    st.data.lastCleanupAt = t;
    st.touch(300);
    if (removedFiles || removedFp || droppedPending) {
      log(`清理（${why}）：删存档 ${removedFiles} 份、清指纹 ${removedFp} 个、丢过期暂存 ${droppedPending} 条`);
    }
    // 回执：这活儿 30 分钟才跑一次，按"每轮都报"处理（带 expectMin 让看门狗能盯住它）。
    receiptTell({
      plugin: 'forward-relay',
      task: 'cleanup',
      outcome: (removedFiles || removedFp || droppedPending) ? 'sent' : 'idle',
      summary: (removedFiles || removedFp || droppedPending)
        ? `清理：删存档 ${removedFiles} 份、清指纹 ${removedFp} 个、丢过期暂存 ${droppedPending} 条`
        : '清理：没有过期的存档/指纹/暂存',
      expectMin: Math.max(1, Math.round(Number(s.cleanupIntervalMin) || 30))
    });
    return { ok: true, removedFiles, removedFp, droppedPending };
  } catch (error) {
    warn(`清理出错（${why}）：${error?.message ?? error}`);
    receiptTell({
      plugin: 'forward-relay',
      task: 'cleanup',
      outcome: 'fail',
      summary: `清理出错：${error?.message ?? error}`,
      expectMin: Math.max(1, Math.round(Number(settings().cleanupIntervalMin) || 30))
    });
    return { ok: false, reason: error?.message ?? String(error) };
  }
}

/* ══════════════════════════════════════════════════════════════════════
   主人口令的实现
   ══════════════════════════════════════════════════════════════════════ */

/** 真正发出去（确认 / auto 共用）：返回 {ok, method, ...} 并把目标群记账。 */
async function relayToTargets(item, targets) {
  const results = [];
  const okTargets = [];
  for (const t of targets) {
    const r = await sendForwardTo('group', t, item, { targetName: groupNameOf(t) });
    results.push(r);
    if (r.ok) {
      okTargets.push(t);
      registerFingerprint(t, item.fp8, now());
      writeArchive({ groupId: t, item, status: 'sent' });
    }
  }
  return { results, okTargets, failed: targets.filter((t) => !okTargets.includes(t)) };
}

/** `\转发 <编号> [群号]`：把某条暂存真的发出去。 */
async function confirmPending(raw = '') {
  try {
    const s = settings();
    await boot();
    prunePending();
    const { id, groups } = mods.core.parseRelayArgs(raw);
    const items = Array.isArray(st.data.pending) ? st.data.pending : [];
    if (!items.length) {
      return { ok: false, text: '屎壳郎这里没有待确认的转发（可能已经发过、或者过期被清掉了）。' };
    }
    const item = findPending(id);
    if (!item) {
      return { ok: false, text: `没有编号 ${id} 的待确认转发。发 \\转发状态 看清单。` };
    }
    // item.targets 里可能留着"后来在别处已经安静登记过"的群，先剔掉，免得永远挂着
    const own = (Array.isArray(item.targets) ? item.targets : []).filter((t) => shouldRelay(item.fp8, t));
    if (own.length !== (Array.isArray(item.targets) ? item.targets.length : 0)) {
      item.targets = own;
      st.touch();
    }
    // 主人点名要发的群，如果在导向群列表里、而且**已经有同一份内容**（指纹相同），
    // 不能闷头就发：第一次只回报 + 挂一张 10 分钟的「强发许可」，
    // 同一个编号 + 同一批群再回一次同样的口令，才按"强发"处理。
    const allTargets = gids(s.targetGroups);
    const blocked = groups.filter((g) => allTargets.includes(g) && !shouldRelay(item.fp8, g));
    const fc = st.data.forceConfirm;
    const fcKey = `${item.id}|${[...blocked].sort().join(',')}`;
    const forced = Boolean(blocked.length && fc && fc.key === fcKey && now() - (Number(fc.at) || 0) <= FORCE_CONFIRM_MS);
    if (blocked.length && !forced) {
      st.data.forceConfirm = { key: fcKey, at: now(), groups: blocked.slice() };
      st.touch(0);
      log(`#${item.id} 点名的 ${blocked.join('、')} 里已经有这条内容，先问一声要不要强发`);
      return {
        ok: true,
        text: `⚠️ #${item.id} 要发的「${blocked.map(labelOf).join('、')}」里**已经有这条内容了**`
          + `（同一份，指纹 ${item.fp8}），薄荷没有发。\n`
          + `还要再发一遍的话，就再回一次同样的口令：\\转发 ${item.id} ${blocked.join(' ')} —— 这次薄荷就真发过去。\n`
          + `（${Math.round(FORCE_CONFIRM_MS / 60000)} 分钟内有效；不想发就 \\不转 ${item.id}）`
      };
    }
    if (forced) delete st.data.forceConfirm;

    let targets = groups.length ? own.filter((t) => groups.includes(t)) : own;
    if (forced) targets = [...new Set([...targets, ...blocked])];
    if (!targets.length) {
      if (groups.length) {
        // 指名道姓要发的群不在待转列表里 —— 只回报，**别把整条暂存丢掉**（别的群可能还等着）
        const missing = groups.filter((g) => !allTargets.includes(g));
        const other = groups.filter((g) => allTargets.includes(g));
        const why = [];
        if (missing.length) why.push(`${missing.map(labelOf).join('、')} 不在导向群列表（targetGroups）里`);
        if (other.length) why.push(`${other.map(labelOf).join('、')} 现在不欠着这条了（可能刚发过）`);
        return {
          ok: false,
          text: `#${item.id} 什么都没发：${why.join('；') || '群号对不上'}。`
        };
      }
      dropFromPending(item.id, 'archived-only', 'confirm-empty');
      const f = archivePathFor(item);
      setArchiveStatus(f, 'archived-only');
      return {
        ok: false,
        text: `#${item.id} 列出的导向群（${labelList(item.targets)}）里都已经有这条内容了，什么都没发（存档：${f}）。`
      };
    }

    const { results, failed } = await relayToTargets(item, targets);
    const anyOk = results.some((r) => r.ok);
    // ⚠️ 只把**这次真发成功的**从暂存里划掉：主人可能只指定了一个群，
    //    剩下的群还得留在待处理里（否则 \转发 <编号> 挑群发一次就把其余目标吞了）。
    const sent = targets.filter((t) => !failed.includes(t));
    const rest = (Array.isArray(item.targets) ? item.targets : []).filter((t) => !sent.includes(t));
    if (rest.length) {
      item.targets = rest;
      st.touch();
    } else {
      dropFromPending(item.id, 'sent', 'confirm');
    }
    const f = archivePathFor(item);
    if (anyOk) setArchiveStatus(f, 'sent');
    st.touch(0);
    const tail = rest.length
      ? `\n（还剩 ${labelList(rest)} 没发，要发就再 \\转发 ${item.id}）`
      : (failed.length ? `\n（${labelList(failed)} 发送失败，这条留着，可以再 \\转发 ${item.id} 重试）` : '');
    log(`主人确认转发 #${item.id}：${labelList(targets)} → ${results.filter((r) => r.ok).length}/${results.length} 成功`);
    return { ok: anyOk, text: `${mods.core.renderSendReceipt(results, labelOf)}${tail}` };
  } catch (error) {
    warn(`确认转发出错：${error?.message ?? error}`);
    return { ok: false, text: `确认转发出错：${error?.message ?? error}` };
  }
}

/** `\不转 <编号>`：丢掉暂存（存档留着）。 */
async function dropPending(raw = '') {
  try {
    await boot();
    prunePending();
    const { id } = mods.core.parseRelayArgs(raw);
    const item = findPending(id);
    if (!item) {
      const any = Array.isArray(st.data.pending) && st.data.pending.length;
      // 「没有待确认的转发」是**正常结果**，不是执行失败（2026-10-04 真机事故）：
      // 原先这里返回 ok:false → 工具回 isError:true → 核心把"指令直达失败"当回事，
      // 走兜底回落模型（`＼不转 1` 就得到了一个 0 token 会话 + 一次 26.9k prompt
      // token 的模型调用，模型没有 hidden 手柄，只能回一句"不回应不凑热闹"）。
      // 用户要的"别转"这件事已经成立了 —— 队列里本来就没有待转的东西。
      return {
        ok: true,
        text: any
          ? `没有编号 ${id} 的待确认转发（队列里还有 ${st.data.pending.length} 条，用 \\转发状态 看编号）。`
          : '屎壳郎这里没有待确认的转发（没有需要丢掉的东西）。'
      };
    }
    const f = archivePathFor(item);
    dropFromPending(item.id, 'archived-only', 'owner-drop');
    setArchiveStatus(f, 'archived-only');
    st.touch(0);
    log(`主人放弃转发 #${item.id}（指纹 ${item.fp8}），存档留着：${f}`);
    return { ok: true, text: `已丢掉 #${item.id}（来源群 ${labelOf(item.srcGroup)} 的 ${item.count} 条）。存档还在，需要时能翻：${f}` };
  } catch (error) {
    warn(`放弃转发出错：${error?.message ?? error}`);
    return { ok: false, text: `放弃转发出错：${error?.message ?? error}` };
  }
}

/** `\转发状态`：一眼看清待处理 / 指纹 / 存档。 */
function renderStatusText() {
  const s = settings();
  const items = livePending();
  const stats = archiveStats();
  const t = now();
  const lines = [
    `📮 屎壳郎 · ${s.enabled ? '开着' : '关着'} · 模式 ${s.mode === 'auto' ? 'auto（薄荷判断）' : 'ask（等主人确认）'}`,
    `注入群：${labelList(gids(s.injectGroups))}`,
    `导向群：${labelList(gids(s.targetGroups))}`,
    `待处理 ${items.length} 条 · 存档 ${stats.files} 份（${stats.groups} 个群）· 指纹 ${countFingerprints()} 个 · 编号每天重置（今天 ${st?.data?.dayKey || dayKeyOf()} 从 1 起）`,
    `存档有效期 ${s.ttlHours} 小时 · 每群最多 ${s.maxArchivePerGroup} 份 · 纯文本回退 ${s.textFallback ? '开' : '关'} · 原文先发 ${s.pushOriginal ? `开（每轮最多 ${s.maxPushPerScan} 张）` : '关'}`,
    `未回复超时：${s.mode === 'ask'
      ? (s.replyTimeoutMin > 0 ? `${s.replyTimeoutMin} 分钟没回复就自动丢掉（静默，只写日志）` : '关（一直等你拍板）')
      : `不适用（auto 模式不问主人，按存档有效期 ${s.ttlHours} 小时）`}`,
    `暂存去重：${s.dedupeHours > 0
      ? `同一份内容（指纹相同）${s.dedupeHours} 小时内只问你一次（已记账 ${countStagedFp()} 份）`
      : '关（同一份内容被反复扫到就会反复问你）'}`
  ];
  // C 方案：把「核心没存档 → 插件其实看不见」「转发展开失败被放弃」摆到明面上
  const noArch = gids(s.injectGroups).filter((g) => !hasCoreArchive(g));
  if (noArch.length) {
    lines.push(s.historyFallback
      ? `⚠️ 这些注入群核心没写存档（靠 OneBot 兜底拉取，每次最近 ${s.historyCount} 条）：`
      : `⚠️ 这些注入群核心没写存档，兜底拉取关着 —— 插件看不到它们的任何消息：`);
    for (const g of noArch) {
      const h = st?.data?.historyState?.[String(g)];
      let tail = '还没拉过（等下一轮扫描）';
      if (h) {
        tail = h.ok
          ? `最近一次 ${mods.core.humanTime(h.at)} 拉到 ${h.got} 条（其中 ${h.forwards} 条新转发）`
          : `最近一次 ${mods.core.humanTime(h.at)} 拉取失败：${h.error}`;
      }
      lines.push(`    · ${labelOf(g)}：${tail}`);
    }
  }
  const failList = Object.entries(st?.data?.failures || {})
    .sort((a, b) => (Number(b[1]?.ts) || 0) - (Number(a[1]?.ts) || 0));
  if (failList.length) {
    const [fmid, f] = failList[0];
    lines.push(`⚠️ 取不到内容的转发 ${failList.length} 条（重试 ${MAX_FETCH_RETRY} 次后已放弃）；最近 mid=${fmid} · ${mods.core.humanTime(f?.ts)} · ${String(f?.reason || '').slice(0, 80)}`);
  }
  lines.push('');
  if (!items.length) {
    lines.push('（没有待确认的转发）');
  } else {
    for (const it of items) {
      // ask 模式里"还剩多久"说的不是存档有效期，而是**主人的回复时限**（超时即丢）。
      // 起点与 dropTimedOutPending 保持一致：原文卡片送到手里的那一刻，没有才退回扫描时刻。
      const left = s.mode === 'ask' && s.replyTimeoutMin > 0
        ? `${Math.max(0, Math.round(((Number(it.pushedAt) || Number(it.at)) + s.replyTimeoutMin * 60000 - t) / 60000))} 分钟后未回复就自动丢`
        : `存档还剩 ${Math.max(0, Math.round((Number(it.expiresAt) - t) / 60000))} 分钟`;
      lines.push(`【${it.id}】${labelOf(it.srcGroup)} · ${it.count} 条 · ${it.senderName || '未知'}(${it.senderId || '?'}) · ${left}${it.pushedAt ? ' · 原文已推' : ''}`);
      const can = (it.targets || []).filter((x) => shouldRelay(it.fp8, x));
      lines.push(`    可转：${can.length ? labelList(can) : '（都已经有了）'}`);
      // 已经有这份内容的导向群不列进「可转」，但摆出来说清楚（主人 2026-10-04：别把已有的群当备选）
      const dupNow = (it.dupes || []).filter((x) => !shouldRelay(it.fp8, x));
      if (dupNow.length) lines.push(`    已有（没列进可转）：${labelList(dupNow)}`);
      lines.push(`    存档：${archivePathFor(it)}`);
    }
    lines.push('', `\\转发 <编号> [群号] 发出去 · \\不转 <编号> 丢掉`);
  }
  return lines.join('\n');
}

/**
 * `\转发测试`：往**主人私聊**发一条两节点的假合并转发，验证节点格式。
 *
 * 硬规则：测试消息只发主人私聊，绝不发任何群（主人在 2026-10-05 明确要求）。
 * 回执里报成功（message_id/res_id）或原始报错。
 */
async function relayTest() {
  try {
    await boot();
    const to = ownerTarget();
    if (!to.id) {
      return { ok: false, text: '找不到主人 QQ（设置 askTo / owner-identity.ids / group-reports.ownerQq 三处都空），不发。' };
    }
    const t = now();
    const item = {
      text: `[合并转发 共2条]\n薄荷屎壳郎: 薄荷屎壳郎测试 1/2（假数据，只发给主人私聊）\n薄荷屎壳郎: 薄荷屎壳郎测试 2/2`,
      nodes: [
        {
          type: 'node',
          data: {
            nickname: '薄荷屎壳郎',
            content: [{ type: 'text', data: { text: `薄荷屎壳郎测试 1/2：这条是假数据，用来验证 send_private_forward_msg 的节点格式（${mods.core.humanTime(t)}）` } }]
          }
        },
        {
          type: 'node',
          data: {
            nickname: '薄荷屎壳郎',
            content: [{ type: 'text', data: { text: '薄荷屎壳郎测试 2/2：收到就说明节点格式没问题，relay_send 可以放心用。' } }]
          }
        }
      ]
    };
    const r = await sendForwardTo('private', to.id, item, { targetName: '主人私聊' });
    if (r.ok) {
      const raw = r.raw ?? {};
      const info = [
        typeof raw.message_id === 'undefined' ? '' : `message_id=${raw.message_id}`,
        raw.res_id ? `res_id=${raw.res_id}` : '',
        raw.forward_id ? `forward_id=${raw.forward_id}` : ''
      ].filter(Boolean).join(' · ') || JSON.stringify(raw).slice(0, 160);
      const text = `✅ 测试转发已发到主人私聊（${to.id}，来源 ${to.from}）\n方式：${r.method === 'text' ? `纯文本回退（合并转发失败：${r.error}）` : '合并转发（2 个节点）'}\n${info}`;
      log(`\\转发测试成功（${r.method}）：${info}`);
      return { ok: true, text };
    }
    const text = `❌ 测试转发失败（只发主人私聊，没碰任何群）\n${r.error}`;
    warn(`\\转发测试失败：${r.error}`);
    return { ok: false, text };
  } catch (error) {
    warn(`\\转发测试异常：${error?.message ?? error}`);
    return { ok: false, text: `\\转发测试异常：${error?.message ?? error}` };
  }
}

/* ══════════════════════════════════════════════════════════════════════
   工具
   ══════════════════════════════════════════════════════════════════════ */

function registerTools(api) {
  // ── 主人口令（hidden + ownerOnly：0 token，不进模型工具表）──────────
  api.registerTool({
    id: 'relay_confirm',
    name: '确认转发',
    description: '把暂存的合并转发真的发到导向群（主人口令：\\转发 <编号> [群号]）。',
    category: 'utility',
    icon: '📮',
    parameters: { type: 'object', properties: {}, required: [] },
    async execute(ctx) {
      const raw = String(ctx?.commandRoute?.args ?? '').trim();
      const r = await confirmPending(raw);
      return { content: r.text, _directText: r.text, isError: !r.ok };
    }
  });

  api.registerTool({
    id: 'relay_drop',
    name: '放弃转发',
    description: '丢掉待确认的合并转发（主人口令：\\不转 <编号>）。',
    category: 'utility',
    icon: '🗑️',
    parameters: { type: 'object', properties: {}, required: [] },
    async execute(ctx) {
      const raw = String(ctx?.commandRoute?.args ?? '').trim();
      const r = await dropPending(raw);
      return { content: r.text, _directText: r.text, isError: !r.ok };
    }
  });

  api.registerTool({
    id: 'relay_status',
    name: '转发状态',
    description: '看待确认的合并转发、指纹与存档统计（主人口令：\\转发状态）。',
    category: 'utility',
    icon: '📋',
    parameters: { type: 'object', properties: {}, required: [] },
    async execute() {
      await boot();
      await resolveGroupNames(configuredGroups());
      const text = renderStatusText();
      return { content: text, _directText: text };
    }
  });

  api.registerTool({
    id: 'relay_help',
    name: '屎壳郎帮助',
    description: '屎壳郎的用法说明（主人口令：\\转发帮助）。',
    category: 'utility',
    icon: '❓',
    parameters: { type: 'object', properties: {}, required: [] },
    async execute() {
      await boot();
      await resolveGroupNames(configuredGroups());
      const text = mods.core.renderHelpText(settings(), labelOf);
      return { content: text, _directText: text };
    }
  });

  api.registerTool({
    id: 'relay_test',
    name: '转发测试',
    description: '往主人私聊发一条假的合并转发，验证节点格式（主人口令：\\转发测试）。',
    category: 'utility',
    icon: '🧪',
    parameters: { type: 'object', properties: {}, required: [] },
    async execute() {
      const r = await relayTest();
      return { content: r.text, _directText: r.text, isError: !r.ok };
    }
  });

  // ── 模型工具（auto 模式：薄荷自己判断要不要转）──────────────────────
  // 不在 commandRoute 里 → 它留在模型的工具表里，由 providers['tool.guard']
  // 在"非注入群 / 没有新鲜暂存 / 不是 auto 模式"时直接否决（模型连看都看不到）。
  api.registerTool({
    id: 'relay_send',
    name: '转发合并转发',
    description: '把暂存的某条合并转发发到一个或多个导向群（只在 auto 模式、且当前是注入群、且真的有新鲜暂存时才可用）。调用时必须带 confidence：你对「这条够沙雕/抽象/搞怪」的自信度 1-10，低于设定阈值插件会直接拒绝发送。',
    category: 'utility',
    icon: '📤',
    parameters: {
      type: 'object',
      properties: {
        stashId: { type: 'integer', description: '暂存编号（提示词里每条前面的【编号】）' },
        confidence: { type: 'integer', description: '你对「这条值得转（够沙雕/抽象/搞怪）」的自信度，1-10；插件只放行 ≥ 阈值（默认 7）的，拿不准就别发' },
        targetGroups: { type: 'string', description: '要发到哪些导向群，逗号分隔群号；不填 = 所有还没有这条内容的导向群' }
      },
      required: ['stashId', 'confidence']
    },
    async execute(ctx, args) {
      try {
        const s = settings();
        await boot();
        if (s.mode !== 'auto') {
          return { content: '现在是 ask 模式：转发要主人回 \\转发 <编号> 确认，模型不能自己发。', isError: true };
        }
        // 自信度闸门（主人 2026-10-04 定的口径）：判断的自信度 1-10，低于阈值一律不发
        const conf = Number(args?.confidence);
        if (!Number.isFinite(conf) || conf < 1 || conf > 10) {
          return {
            content: `这条没给可用的自信度（收到：${args?.confidence === undefined ? '空' : String(args.confidence)}）。`
              + '请先按口径打一个 1-10 的数：10 = 一眼就是沙雕/抽象/搞怪，1 = 完全不是。',
            isError: true
          };
        }
        const minConf = s.minConfidence;
        if (conf < minConf) {
          return {
            content: `自信度 ${conf}/10 < 阈值 ${minConf}/10：这条不转（插件没发任何群）。什么都别做，也不用问主人。`,
            isError: false
          };
        }
        const item = findPending(args?.stashId);
        if (!item) {
          return { content: `错误：没有编号 ${args?.stashId} 的暂存转发（可能已经发过或过期了）。`, isError: true };
        }
        const want = gids(args?.targetGroups);
        let targets = (Array.isArray(item.targets) ? item.targets : []).filter((t) => shouldRelay(item.fp8, t));
        if (want.length) targets = targets.filter((t) => want.includes(t));
        if (!targets.length) {
          // 模型（auto 模式）报来的群如果已经有这条，就不发 —— 只有主人口令能强发（confirmPending）
          const dupNames = want.filter((g) => !shouldRelay(item.fp8, g));
          return {
            content: dupNames.length
              ? `这${dupNames.length > 1 ? '些' : ''}导向群（${labelList(dupNames)}）已经有同一条内容了，不用再发。`
              : '这些导向群都已经有这条内容了，不用再发。',
            isError: false
          };
        }
        // 回执/告知里要写群名：没缓存就现查一次（取不到就退化成群号，不影响发送）
        await resolveGroupNames([item.srcGroup, ...targets], { timeoutMs: 5000 });
        const { results, failed } = await relayToTargets(item, targets);
        const okTargets = targets.filter((t) => !failed.includes(t));
        // 同 confirmPending：只划掉这次真发成功的，模型指定了子集时其余目标要留着
        const rest = (Array.isArray(item.targets) ? item.targets : []).filter((t) => !okTargets.includes(t));
        if (rest.length) {
          item.targets = rest;
          st.touch();
        } else {
          dropFromPending(item.id, 'sent', 'auto');
        }
        st.touch(0);
        const receipt = mods.core.renderSendReceipt(results, labelOf);
        if (okTargets.length && s.notifyOnAuto) {
          await resolveGroupNames([item.srcGroup, ...okTargets], { timeoutMs: 5000 });
          await notifyOwner(
            `📮 屎壳郎：已替你把 #${item.id} 转到 ${labelList(okTargets)}\n`
            + `（${item.count} 条，来源群 ${labelOf(item.srcGroup)} · 薄荷的自信度 ${conf}/10）`, 'auto 告知');
        }
        log(`auto 转发 #${item.id}（自信度 ${conf}/10）：${labelList(targets)} → ${okTargets.length}/${targets.length} 成功`);
        return { content: `${receipt}\n· 自信度 ${conf}/10（阈值 ${minConf}）` };
      } catch (error) {
        warn(`relay_send 出错：${error?.message ?? error}`);
        return { content: `转发出错：${error?.message ?? error}`, isError: true };
      }
    }
  });
}

/* ══════════════════════════════════════════════════════════════════════
   钩子 / 提示词片段 / 能力
   ══════════════════════════════════════════════════════════════════════ */

/**
 * before-context：薄荷在注入群里被叫到时顺手扫一次，让这一轮的暂存是最新的。
 *
 * 为什么要限时：钩子在热路径上，扫描要读 7.6MB 的群档案 + 可能打一次 get_forward_msg，
 * 不能让一句普通的闲聊等它。（mtime 门控挡掉绝大多数空扫。）
 */
async function onBeforeContext(ctx = {}) {
  try {
    const s = settings();
    if (!s.enabled) return;
    const kind = String(ctx?.kind ?? String(ctx?.chatKey ?? '').split(':')[0]);
    const chatId = String(ctx?.chatId ?? String(ctx?.chatKey ?? '').split(':')[1] ?? '');
    if (kind !== 'group' || !gids(s.injectGroups).includes(chatId)) return;
    await Promise.race([scanOnce('hook'), sleep(3000)]);
  } catch (error) {
    warn(`before-context 出错：${error?.message ?? error}`);
  }
}

/**
 * promptSections：auto 模式下把"待判断的暂存 + 可转的导向群"喂给薄荷。
 *
 * 只在"薄荷正在注入群这一轮说话"时出现 —— 别的地方注入纯属浪费 token，
 * 还会让薄荷在无关群里提起屎壳郎的事。
 */
export function promptSections(context = {}) {
  try {
    const s = settings();
    if (!s.enabled || s.mode !== 'auto' || !st) return [];
    const kind = String(context?.kind ?? String(context?.chatKey ?? '').split(':')[0]);
    const chatId = String(context?.chatId ?? String(context?.chatKey ?? '').split(':')[1] ?? '');
    if (kind !== 'group' || !gids(s.injectGroups).includes(chatId)) return [];
    const items = livePending();
    if (!items.length) return [];
    const lines = [
      '【屎壳郎】你盯着的注入群里有这些合并转发，导向群那边**还没有**同一条内容：',
      ''
    ];
    for (const it of items) {
      const targets = (it.targets || []).filter((t) => shouldRelay(it.fp8, t));
      if (!targets.length) continue;
      lines.push(`【${it.id}】来源群 ${labelOf(it.srcGroup)} · ${it.count} 条 · ${it.senderName || '未知'}(${it.senderId || '?'}) · 收到 ${mods.core.shortTime(it.at)}`);
      for (const l of mods.core.previewOf(it.text, s.previewLines, s.previewChars)) lines.push(`    预览：${l}`);
      lines.push(`    存档（要看全文用文档工具读它）：${archivePathFor(it)}`);
      lines.push(`    可转的导向群（写名字和群号，targetGroups 要用群号）：${labelList(targets)}`);
      // 已经有这条内容的导向群不进候选（插件也会自己拦），这里说明一句免得模型看不懂为什么少了一个群
      const dup = (it.dupes || []).filter((t) => !shouldRelay(it.fp8, t));
      if (dup.length) lines.push(`    （${labelList(dup)} 里已经有同一条内容了，没列进候选，也别往那儿发）`);
    }
    const guide = String(s.judgeGuide || '').trim();
    if (guide) {
      lines.push('', '【判定口径（主人定下的，以此为准）】', guide);
    }
    lines.push(
      '',
      `给每条打一个 1-10 的自信度（10 = 一眼就是沙雕/抽象/搞怪，1 = 完全不是；当前放行线 ${s.minConfidence}）。`,
      '判断值得转，就调用工具 relay_send（完整名 forward-relay__relay_send）：'
      + '{"stashId": <编号>, "confidence": <1-10>, "targetGroups": "群号,群号"}；'
      + '不填 targetGroups = 上面列出的全部导向群。confidence 必填，低于放行线插件会直接拒绝。',
      guide
        ? '按上面的口径和自信度拿不准就当不值得转：不要往外发、不要在群里提这件事、也不用问主人。'
        : '不值得转就什么都不做：不要往外发、不要在群里提这件事、也不用问主人。',
      '（发出去之后插件会自动私聊主人一句"已转到 X 群（自信度 N/10）"，你正常说话就行。）'
    );
    return [{
      id: 'forward-relay-pending',
      title: '屎壳郎',
      priority: 45,
      content: lines.join('\n')
    }];
  } catch (error) {
    warn(`promptSections 出错：${error?.message ?? error}`);
    return [];
  }
}

/** 对外能力：状态查询 + 模型工具的门禁。 */
export const providers = {
  /**
   * tool.guard：relay_send 的运行时门禁。
   * 不满足条件时模型**连工具都看不见**（比只在描述里写"别乱用"可靠得多）。
   * 别的工具一律不表态（返回 undefined = 不否决），免得拖慢每一次可用性检查。
   */
  'tool.guard': ({ toolId, context } = {}) => {
    try {
      const id = String(toolId || '');
      if (!(id === 'relay_send' || id.endsWith('__relay_send'))) return undefined;
      const s = settings();
      if (!s.enabled) return { ok: false, reason: '屎壳郎已关闭' };
      if (s.mode !== 'auto') return { ok: false, reason: '屎壳郎现在是 ask 模式，转发由主人 \\转发 <编号> 确认' };
      if (!st || !livePending().length) return { ok: false, reason: '没有待判断的合并转发' };
      const kind = String(context?.kind ?? String(context?.chatKey ?? '').split(':')[0]);
      const chatId = String(context?.chatId ?? String(context?.chatKey ?? '').split(':')[1] ?? '');
      if (kind !== 'group' || !gids(s.injectGroups).includes(chatId)) {
        return { ok: false, reason: '只在自己监听的注入群里才谈得上转发' };
      }
      return undefined;
    } catch {
      return { ok: false, reason: '屎壳郎门禁异常' };
    }
  },
  'forward-relay.status': () => {
    try {
      return {
        enabled: settings().enabled,
        mode: settings().mode,
        injectGroups: gids(settings().injectGroups),
        targetGroups: gids(settings().targetGroups),
        pending: st ? livePending().length : 0,
        fingerprints: countFingerprints(),
        archives: st ? archiveStats().files : 0,
        armedAt: Number(st?.data?.armedAt) || 0,
        lastScanAt: Number(st?.data?.lastScanAt) || 0
      };
    } catch {
      return null;
    }
  }
};

export const hooks = {
  'before-context': (ctx) => onBeforeContext(ctx).catch((error) => warn(`before-context 出错：${error?.message ?? error}`))
};

/* ══════════════════════════════════════════════════════════════════════
   生命周期
   ══════════════════════════════════════════════════════════════════════ */

let scanTimer = null;
let cleanTimer = null;

function startTimers() {
  const s = settings();
  if (!scanTimer) {
    scanTimer = setInterval(() => { scanOnce('timer').catch(() => {}); }, s.scanIntervalSec * 1000);
    scanTimer.unref?.();
  }
  if (!cleanTimer) {
    cleanTimer = setInterval(() => { cleanup('timer').catch(() => {}); }, s.cleanupIntervalMin * 60000);
    cleanTimer.unref?.();
  }
}

function stopTimers() {
  if (scanTimer) { clearInterval(scanTimer); scanTimer = null; }
  if (cleanTimer) { clearInterval(cleanTimer); cleanTimer = null; }
}

export async function setup(api) {
  apiRef = api;
  cfgFn = api.config;
  try {
    const tell = api;
    receiptTell = (patch) => { try { tell?.capability?.('receipt.report', patch); } catch { /* 回执永远不能影响主流程 */ } };
  } catch { /* ignore */ }
  await boot();
  registerTools(api);
  const s = settings();
  log(`屎壳郎已装载：模式 ${s.mode} · 注入群 ${labelList(gids(s.injectGroups))}`
    + ` → 导向群 ${labelList(gids(s.targetGroups))} · 存档 ${archiveRoot()}`);
  // 群名后台预热（不阻塞装载）：下一轮的询问/回执就能直接写群名
  resolveGroupNames(configuredGroups(s)).catch(() => {});
}

export function available() {
  return { ok: true };
}

export async function activate() {
  try {
    await boot();
    const s = settings();
    if (!s.enabled) { log('屎壳郎是关着的（插件设置 enabled=false）'); return; }
    if (!gids(s.injectGroups).length) { log('没有配置注入群，屎壳郎待机'); return; }
    arm(s);
    startTimers();
    resolveGroupNames(configuredGroups(s)).catch(() => {});   // 群名预热（不阻塞定时器）
    log(`定时器已起：每 ${s.scanIntervalSec} 秒扫一次注入群，每 ${s.cleanupIntervalMin} 分钟清一次过期存档`);
    setTimeout(() => { scanOnce('activate').catch(() => {}); }, 3000).unref?.();
  } catch (error) {
    warn(`启动出错：${error?.message ?? error}`);
  }
}

export function deactivate(reason) {
  try {
    stopTimers();
    try { st?.flush?.(); } catch { /* ignore */ }
    // ⚠️ 核心热重载调的是 `deactivate({ reason: 'reload' })`（**对象**，不是字符串）；
    //    兼容两种形态，否则改了 lib 之后热重载永远拿旧模块（幽灵实例）。
    const why = typeof reason === 'string' ? reason : String(reason?.reason || '');
    if (why === 'reload' || why === 'dispose') {
      st = null;
      mods = null;
      midSet = new Set();
      lastSendAt = new Map();
      libCache = new Map();
      nameCache.clear();
      scanBusy = false;
    }
  } catch { /* ignore */ }
}

export function dispose() {
  deactivate('dispose');
}

/** 排障 / 自测入口。 */
export const internals = {
  settings,
  boot,
  scanOnce,
  cleanup,
  confirmPending,
  dropPending,
  relayTest,
  renderStatusText,
  sendForward: sendForwardTo,
  relayToTargets,
  notifyOwner,
  ownerTarget,
  isOwnerId,
  hasFingerprint,
  registerFingerprint,
  shouldRelay,
  writeArchive,
  setArchiveStatus,
  archiveStats,
  archiveRoot,
  groupDir,
  archivePathFor,
  livePending,
  findPending,
  parseGroupIds: (raw) => gids(raw),
  groupNameOf,
  labelOf,
  labelList,
  resolveGroupNames,
  configuredGroups,
  fingerprint: (text) => (mods ? mods.core.fingerprint(text) : ''),
  fingerprint8: (fp) => (mods ? mods.core.fp8(fp) : ''),
  renderAskText: (items, s, opts) => mods.core.renderAskText(items, s || settings(), labelOf, opts),
  promptSections,
  // A：注入群没有核心存档时的 OneBot 历史兜底；C：静默失败的可见性
  scanHistory,
  entryFromOnebot,
  hasCoreArchive,
  coreArchiveFile,
  warnNoArchive,
  notifyGiveUp,
  // 原文先发一份：把原始合并转发直接私聊给主人（比纯文字预览直观）
  pushOriginalsToOwner,
  // 未回复超时（5 分钟自动丢）+ 暂存编号每天重置
  dropTimedOutPending,
  dayKeyOf,
  ensureDayKey,
  get state() { return st?.data ?? null; },
  get store() { return st; },
  get mods() { return mods; },
  /**
   * 自测注入点（只给 `data/forward-relay-selftest.mjs` 用）。
   * 生产路径永远不会调它 —— 目的是让自测能用临时目录 / 假时钟 / mock OneBot，
   * 不碰真状态文件、不发真消息。
   */
  __test: {
    configure(opts = {}) {
      if ('stateFile' in opts) stateFileOverride = String(opts.stateFile || '');
      if ('now' in opts) nowFn = typeof opts.now === 'function' ? opts.now : null;
      if ('caller' in opts) callOverride = typeof opts.caller === 'function' ? opts.caller : null;
      if ('config' in opts) cfgFn = typeof opts.config === 'function' ? opts.config : (() => ({}));
    },
    reset() {
      stopTimers();
      try { st?.flush?.(); } catch { /* ignore */ }
      st = null;
      mods = null;
      midSet = new Set();
      lastSendAt = new Map();
      callOverride = null;
      nowFn = null;
      stateFileOverride = '';
      nameCache.clear();
      scanBusy = false;
    },
    /** 把工具定义抓出来（registerTools 只用到 api.registerTool，一个假壳就够）。 */
    tools() {
      const out = new Map();
      registerTools({ registerTool: (def) => out.set(def.id, def) });
      return out;
    }
  }
};
