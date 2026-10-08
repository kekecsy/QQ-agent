// forward-relay 的纯逻辑层：群号解析、正文归一化 / 指纹、段过滤与节点重组、文案渲染。
//
// 为什么单独一个文件：
//   ① 这些都是无副作用的纯函数，自测脚本可以直接驱动（不用起定时器、不用连 QQ）；
//   ② index.js 里只留"编排"（扫描 / 定时器 / 口令 / 工具），读起来才不费劲。
//
// ⚠️ 本文件**不 import 别的 lib**：lib 是被 `import('./lib/x.js?<mtime>')` 加载的
//    （见 index.js 的 lib()），跨文件的相对 import 会命中不带 tag 的另一个 URL，
//    于是同一个函数存在两个实例。纯函数不怕，但没必要留这个坑。

import crypto from 'node:crypto';

/** 一条转发最多重发多少个节点 / 正文最多多少字符（超过就截断，截断要记日志）。 */
export const MAX_NODES = 200;
export const MAX_TEXT_CHARS = 200000;

/* ══════════════════════════════════════════════════════════════════════
   群号 / 时间
   ══════════════════════════════════════════════════════════════════════ */

/**
 * 解析「逗号 / 中文逗号 / 顿号 / 分号 / 竖线 / 空格」分隔的群号串。
 *
 * 只认 5~12 位纯数字：设置项是给人手填的，手滑多打一个"群"字或句号时
 * 宁可丢掉那一项，也不要把 `123456.` 之类的垃圾带进 OneBot 调用里。
 * 去重保序 —— 顺序对主人可见（文案里的导向群顺序就是他填的顺序）。
 */
export function parseGroupIds(raw) {
  const out = [];
  const seen = new Set();
  for (const part of String(raw ?? '').split(/[,，、;；|\s]+/)) {
    const id = part.trim();
    if (!/^\d{5,12}$/.test(id)) continue;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

const pad2 = (n) => String(n).padStart(2, '0');

/** 文件名时间戳：`YYYY-MM-DD_HHmm`（本地时间）。不用 toLocaleString —— 它会随 locale 变形。 */
export function stampOf(ts) {
  const d = new Date(Number(ts) || 0);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}_${pad2(d.getHours())}${pad2(d.getMinutes())}`;
}

/** 给人看的时间：`2026-10-05 21:33:02`。 */
export function humanTime(ts) {
  const d = new Date(Number(ts) || 0);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} `
    + `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

/** 文案里的短时间：`21:33`。 */
export function shortTime(ts) {
  const d = new Date(Number(ts) || 0);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/** 从存档文件名 `2026-10-05_2133_ab12cd34.md` 解析出 epoch 毫秒（解析不了返回 0）。 */
export function parseStampMs(name) {
  const m = /^(\d{4})-(\d{2})-(\d{2})_(\d{2})(\d{2})_/.exec(String(name ?? ''));
  if (!m) return 0;
  const [, y, mo, d, h, mi] = m;
  const t = new Date(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), 0, 0).getTime();
  return Number.isFinite(t) ? t : 0;
}

/** 从存档文件名里取 8 位指纹（取不到返回空串）。 */
export function fp8OfFile(name) {
  const m = /^(\d{4}-\d{2}-\d{2}_\d{4})_([0-9a-f]{6,40})\.md$/i.exec(String(name ?? ''));
  return m ? m[2].slice(0, 8).toLowerCase() : '';
}

/** 数值钳位（设置项都过一遍这个，防空值 / NaN / 越界）。 */
export function clampInt(v, d, lo, hi) {
  const n = Number(v);
  if (!Number.isFinite(n)) return d;
  return Math.max(lo, Math.min(hi, Math.trunc(n)));
}

/* ══════════════════════════════════════════════════════════════════════
   转发识别 / 归一化 / 指纹
   ══════════════════════════════════════════════════════════════════════ */

/**
 * 存档里这条消息像不像"合并转发"。
 *
 * 两种真实形态都认（父会话实测）：
 *   ① 核心 ingest 展开成功 → `[合并转发 共5条]\n昵称(QQ:xxx): …`
 *   ② 展开失败 → 只剩占位符 `[合并转发聊天记录]` / 原始 CQ 描述符（含 `[转发消息`）
 * 所以**不能假设文本里有条数**，一切以 mid 去 get_forward_msg 为准。
 */
export function looksLikeForward(text) {
  return /\[(?:合并转发|转发消息)/.test(String(text ?? ''));
}

/** 从原始文本里抠 res_id（`[CQ:forward,id=xxx]`），拿不到返回空串（get_forward_msg 的第二兜底）。 */
export function extractForwardResId(text) {
  const m = /\[CQ:forward[^\]]*\bid=([^,\]]+)/i.exec(String(text ?? ''));
  return m ? m[1].trim() : '';
}

// 头部/正文里的「条数行」：`[合并转发 共5条]`、`[转发消息]`、`[合并转发聊天记录]` …
const HEADER_ONLY_LINE = /^\s*\[\s*(?:合并转发|转发消息|合并转发的消息|聊天记录)[^\]]*\]\s*$/;
const HEADER_INLINE = /^\s*\[\s*(?:合并转发|转发消息|合并转发的消息|聊天记录)[^\]]*\]\s*/;

/**
 * 指纹用的归一化正文。
 *
 * 为什么这么归：判定"原模原样"要跨两次展开（源群展开一次、目标群那份是转发过去的）
 * —— 同一个转发在不同时刻可能因为"共 N 条"的计数、换行/空白差异而不同，
 * 那些都不是内容差异。归一化后只留"谁说了什么"。
 */
export function normalizeForFingerprint(text) {
  let t = String(text ?? '').replace(/\r\n?/g, '\n');
  t = t.replace(HEADER_INLINE, '');
  const kept = [];
  for (const line of t.split('\n')) {
    if (HEADER_ONLY_LINE.test(line)) continue;
    kept.push(line);
  }
  // 空白（含全角空格）全抹掉：排版差异不算内容差异。
  return kept.join('\n').replace(/[\s\u3000]+/g, '');
}

/** 归一化正文的 sha1。 */
export function fingerprint(text) {
  return crypto.createHash('sha1').update(normalizeForFingerprint(text), 'utf8').digest('hex');
}

/** 指纹前 8 位（文件名 / 索引键都用这个）。 */
export function fp8(fp) {
  return String(fp ?? '').slice(0, 8).toLowerCase();
}

/* ══════════════════════════════════════════════════════════════════════
   段过滤 / 节点重组（发送侧）
   ══════════════════════════════════════════════════════════════════════ */

/**
 * 能安全重发的段类型白名单。
 *
 * 依据 SnowLuma 的 `segmentToElement`（index.mjs:4139+）：不认识的段类型它直接抛
 * `UNKNOWN_TYPE`，整张转发都会失败；`reply` 需要活着的 replySeq、`forward` 是套娃
 * 合并转发、`json/xml` 是卡片（内容可能来自别人的会话）。所以只放行这六种，
 * 其余一律折成文本占位符 —— 图/文/表情/语音这些"看得见的内容"一定要留住。
 */
export const SAFE_SEGMENT_TYPES = new Set(['text', 'image', 'face', 'at', 'record', 'video']);

const SEGMENT_PLACEHOLDER = {
  json: '[卡片消息]',
  xml: '[聊天记录]',
  forward: '[合并转发]',
  reply: '[引用消息]',
  poke: '[戳一戳]',
  file: '[文件]',
  location: '[位置]',
  music: '[音乐]',
  share: '[分享]',
  contact: '[推荐联系人]',
  markdown: '[富文本]',
  button: '[按钮]',
  rps: '[猜拳]',
  dice: '[骰子]',
  shake: '[窗口抖动]',
  anonymous: '[匿名消息]'
};

export function placeholderFor(type) {
  const t = String(type ?? '').toLowerCase();
  return SEGMENT_PLACEHOLDER[t] ?? `[${t || '未知'}]`;
}

/** CQ 串 → 纯文本（降级用）：把 `[CQ:xxx,...]` 换成占位符/文本内容。 */
export function cqToPlainText(str) {
  return String(str ?? '').replace(/\[CQ:([a-zA-Z_]+)((?:,[^\]]*)?)\]/g, (all, type, params) => {
    const t = String(type).toLowerCase();
    if (t === 'text') {
      const m = /(?:^|,)text=([^,]*)/.exec(String(params ?? ''));
      return m ? m[1] : '';
    }
    if (t === 'at') {
      const m = /(?:^|,)qq=([^,]*)/.exec(String(params ?? ''));
      return m && m[1] ? `@${m[1]}` : '@某人';
    }
    return placeholderFor(t);
  });
}

/** 只留标量字段：SnowLuma 的 assertScalarSegmentData 会拒掉数组/对象字段。 */
function sanitizeSegmentData(data) {
  const out = {};
  for (const [k, v] of Object.entries(data && typeof data === 'object' ? data : {})) {
    if (v == null) continue;
    if (typeof v === 'object') continue;
    out[k] = v;
  }
  return out;
}

/**
 * 把一条节点正文过滤成"能发出去"的形态。
 * @returns {{content: Array|string, degraded: number}} degraded = 被折成占位符的段数
 */
export function filterContent(message) {
  // CQ 字符串形态：只有全白名单才原样透传；混进别的类型就整条降级成纯文本
  // （逐个 CQ 段重写成段数组要处理转义，风险大于收益 —— 降级只丢卡片，正文还在）。
  if (typeof message === 'string') {
    const types = [...String(message).matchAll(/\[CQ:([a-zA-Z_]+)/g)].map((m) => m[1].toLowerCase());
    const bad = types.filter((t) => !SAFE_SEGMENT_TYPES.has(t));
    if (!bad.length) return { content: message, degraded: 0 };
    return { content: [{ type: 'text', data: { text: cqToPlainText(message) } }], degraded: bad.length };
  }

  const list = Array.isArray(message)
    ? message
    : (message && typeof message === 'object' ? [message] : []);
  const keep = [];
  let degraded = 0;
  for (const seg of list) {
    if (!seg || typeof seg !== 'object') continue;
    const type = String(seg.type ?? '').toLowerCase();
    if (!type) continue;
    if (SAFE_SEGMENT_TYPES.has(type)) {
      const data = sanitizeSegmentData(seg.data);
      // 空文本段 SnowLuma 自己会忽略（isExplicitEmptyTextPlaceholder），这里先丢掉更省字节
      if (type === 'text' && !String(data.text ?? '').trim()) continue;
      keep.push({ type, data });
      continue;
    }
    degraded += 1;
    keep.push({ type: 'text', data: { text: placeholderFor(type) } });
  }
  if (!keep.length) keep.push({ type: 'text', data: { text: '[空消息]' } });
  return { content: keep, degraded };
}

/**
 * 把 get_forward_msg 的节点数组重组成 `send_*_forward_msg` 要的 node 段。
 *
 * 形态（父会话从 SnowLuma parseForwardNodes 确认）：`{type:'node', data:{user_id, nickname, content}}`。
 * ⚠️ 不能用 `{id: <message_id>}` 那套 —— 它要求 SnowLuma 的 messageStore 里还有这条消息，
 *    缓存一过期就报 `forward node message_id not found`。重组节点不依赖任何缓存。
 */
export function rebuildNodes(nodes, { maxNodes = MAX_NODES, maxChars = MAX_TEXT_CHARS } = {}) {
  const list = Array.isArray(nodes) ? nodes : [];
  const messages = [];
  let degraded = 0;
  let truncated = false;
  let size = 0;
  for (const n of list) {
    if (!n || typeof n !== 'object') continue;
    if (messages.length >= maxNodes) { truncated = true; break; }
    const sender = n.sender && typeof n.sender === 'object' ? n.sender : {};
    const raw = n.message ?? n.content ?? '';
    const filtered = filterContent(raw);
    degraded += filtered.degraded;
    const userId = String(sender.user_id ?? n.user_id ?? n.uin ?? '').trim();
    const nickname = String(
      sender.card || sender.nickname || n.nickname || n.name || userId || '某人'
    ).trim();
    const data = { content: filtered.content };
    // user_id 给数字更稳（SnowLuma 那边会 intOr / 比 uin）；nickname 是节点上唯一的展示名
    if (userId) data.user_id = /^\d{1,12}$/.test(userId) ? Number(userId) : userId;
    data.nickname = nickname;
    const node = { type: 'node', data };
    size += JSON.stringify(node).length;
    if (size > maxChars && messages.length >= 1) { truncated = true; break; }
    messages.push(node);
  }
  return { messages, degraded, truncated };
}

/* ══════════════════════════════════════════════════════════════════════
   本地展开（核心 expandForwardNodes 的等价实现，只在动态 import 失败时用）
   ══════════════════════════════════════════════════════════════════════ */

function segmentsToPlainText(segs) {
  const out = [];
  for (const s of Array.isArray(segs) ? segs : []) {
    if (!s || typeof s !== 'object') continue;
    const t = String(s.type ?? '').toLowerCase();
    const d = s.data ?? {};
    if (t === 'text') out.push(String(d.text ?? ''));
    else if (t === 'at') out.push(d.qq ? `@${d.qq}` : '@某人');
    else out.push(placeholderFor(t));
  }
  return out.join('');
}

/**
 * 与 `src/onebot.js` 的 expandForwardNodes 同口径的展开（头 + 每行 `名字(QQ:x): 正文`，
 * 单节点正文截 200 字，maxNodes/maxChars 封顶并注明"还有 N 条未展开"）。
 *
 * 为什么要有一份本地实现：本文件会被"单独跑 node 的自测脚本"加载，那时 src/onebot.js
 * 会连带拉起 ws / 技能管理器，未必解析得动。指纹只要"同一次运行里两边口径一致"，
 * 所以退回本地实现不影响判定，但**正文排版**要跟核心一致，免得出现两种存档格式。
 */
export function expandNodesLocal(nodes, { maxNodes = 30, maxChars = 3000 } = {}) {
  const list = Array.isArray(nodes) ? nodes : [];
  if (!list.length) return null;
  const lines = [];
  let truncated = 0;
  for (let i = 0; i < list.length; i += 1) {
    if (lines.length >= maxNodes) { truncated = list.length - i; break; }
    const n = list[i] || {};
    const rawName = String(n.sender?.card || n.sender?.nickname || n.user_id || '?');
    const nid = String(n.sender?.user_id ?? n.user_id ?? '').trim();
    const name = nid && nid !== rawName ? `${rawName}(QQ:${nid})` : rawName;
    const nm = n.message ?? n.content;
    let body = '';
    if (typeof nm === 'string') body = cqToPlainText(nm);
    else if (Array.isArray(nm)) body = segmentsToPlainText(nm);
    body = body.replace(/\s+/g, ' ').trim().slice(0, 200);
    if (!body) continue;
    lines.push(`${name}: ${body}`);
    if (lines.join('\n').length > maxChars) { truncated = list.length - i - 1; break; }
  }
  const head = `[合并转发 共${list.length}条]`;
  if (!lines.length) return { text: head, media: [] };
  const tail = truncated > 0 ? `\n…（还有 ${truncated} 条未展开）` : '';
  return { text: `${head}\n${lines.join('\n')}${tail}`, media: [] };
}

/* ══════════════════════════════════════════════════════════════════════
   文案渲染
   ══════════════════════════════════════════════════════════════════════ */

/** 预览：跳过 `[合并转发 共N条]` 头与"还有 N 条未展开"尾，每行截 charLimit 字，最多 lineLimit 行。 */
export function previewOf(text, lineLimit = 3, charLimit = 300) {
  const out = [];
  for (const raw of String(text ?? '').split('\n')) {
    if (out.length >= Math.max(1, lineLimit)) break;
    const line = raw.trim();
    if (!line) continue;
    if (HEADER_ONLY_LINE.test(line)) continue;
    if (/^…（还有/.test(line)) continue;
    out.push(line.length > charLimit ? `${line.slice(0, charLimit)}…` : line);
  }
  return out;
}

/** 存档文件正文：头部元信息 + 展开正文（薄荷能用文档工具直接读它）。 */
export function renderArchive({
  at, srcGroup, srcGroupName, senderName, senderId, count, mid, fp, status,
  via, degraded, truncated, body
}) {
  const who = senderId
    ? `${senderName || '未知'}(${senderId})`
    : String(senderName || '未知');
  const from = srcGroupName ? `${srcGroupName}（${srcGroup}）` : String(srcGroup);
  return [
    '# 合并转发快照',
    '',
    `- 时间：${humanTime(at)}`,
    `- 来源群：${from}`,
    `- 发起人：${who}`,
    `- 条数：${count}`,
    `- mid：${mid}`,
    `- 指纹：${fp}`,
    `- 状态：${status}`,
    `- 取节点：${via || 'message_id'}`,
    `- 降级段：${Number(degraded) || 0}（SnowLuma 发不出去的段已折成文本占位符）`,
    `- 截断：${truncated ? '是' : '否'}`,
    '',
    '---',
    '',
    String(body ?? ''),
    ''
  ].join('\n');
}

/** 把存档头部的 `- 状态：xxx` 换掉（其余原样保留）。 */
export function replaceArchiveStatus(text, status) {
  const t = String(text ?? '');
  if (!/^- 状态：/m.test(t)) return `${t}\n- 状态：${status}\n`;
  return t.replace(/^- 状态：.*$/m, `- 状态：${status}`);
}

const STATUS_LABEL = {
  pending: '待处理',
  sent: '已转发',
  'archived-only': '仅存档',
  'skip-exists': '重复-安静',
  dropped: '已丢弃',
  stale: '取不到内容'
};
export function statusLabel(status) {
  return STATUS_LABEL[status] ?? String(status ?? '');
}

/**
 * 群标签：有名字就写「群名（群号）」，没名字就只写群号。
 *
 * 主人的要求（2026-10-04）：**询问和回执主要写群名**，群号只是备注 ——
 * 只给一串数字根本认不出是哪个群。所有要显示群的地方都走这一个函数。
 * 群名从 get_group_info 拿（index.js 的 resolveGroupNames），拿不到就老实退化成群号。
 */
export function groupLabel(id, name) {
  const gid = String(id ?? '').trim();
  const nm = String(name ?? '').trim();
  if (!gid) return nm;
  return nm ? `${nm}（${gid}）` : gid;
}

/**
 * 预览行降噪：`示例昵称(QQ:1234567): 传下去` → `示例昵称：传下去`。
 * 私聊里那串 QQ 号纯属噪音（主人的反馈：触发后的排版太杂乱），
 * 里面的昵称留着 —— 一眼能看出是谁说的话。
 */
export function tidyPreviewLine(line) {
  return String(line ?? '')
    .replace(/\(QQ:\d+\)\s*[:：]?\s*/gi, '：')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/**
 * ask 模式的询问文案：**一批合成一条**（一条一发会把主人的私聊刷爆），
 * 每条转发一个编号，主人回 `\转发 <编号>` 才真的发出去。
 *
 * ⚠️ 口令必须写在**第一行标题底下**（主人 2026-10-04 反馈：口令原来藏在
 * 末尾，前面隔着好几条预览，私聊里一屏根本看不见 → 以为"没有触发转发"）。
 *
 * 排版原则（主人 2026-10-04：「触发后排版杂乱」）：
 *   · 每条**两行头部**（来源群 · 发起人 / 条数 · 时间）+ 若干预览行，不再逐条铺
 *     "发起人：/条数：/预览：/✅回…" 四五个标签 —— 标签本身比内容还长；
 *   · 群名当头，群号只在「只想发其中一个群」那行出现（那里必须照抄）；
 *   · 预览行不带 QQ 号；单条的 `✅ 回 \转发 N` 去掉（标题底下已经讲清）。
 *
 * @param labelOf 可选：`(群号) => '群名（群号）'`。传进来就把**群名**写出来
 *                （主人 2026-10-04：询问里不能只有群号）。不传就退化成群号。
 * @param opts     `{ pushed: N }` → 原文卡片已经先私聊发过 N 张，把卡片与编号的对应写清楚。
 *                 （旧版的 `{ remind: true }` 提醒文案已按主人要求取消：5 分钟不回就直接丢。）
 */
export function renderAskText(items, s = {}, labelOf = null, opts = {}) {
  const lab = typeof labelOf === 'function' ? labelOf : (id) => groupLabel(id, '');
  const n = items.length;
  const cmdOf = (it) => `\\转发 ${it.id}`;
  const pushed = Number(opts?.pushed) || 0;
  const timeoutMin = Number(s.replyTimeoutMin) || 0;
  const lines = [
    `📮 屎壳郎 · ${n} 条待你拍板`,
    `👉 要发就回：${items.map(cmdOf).join(' / ')}`
  ];
  // 原文已经直接私聊过来了（pushOriginal）：说明卡片与下面编号的对应关系，
  // 否则主人看到一串合并转发卡片不知道哪张对应哪个编号。
  if (pushed > 0) lines.push(`📎 原始合并转发已直接发到上面：${pushed} 张卡片，按下面前 ${pushed} 条编号的顺序排`);
  if (timeoutMin > 0) lines.push(`⏳ ${timeoutMin} 分钟没回复就自动丢掉（不再提醒）`);
  lines.push('');
  for (const [i, it] of items.entries()) {
    // 来源群优先用条目自己记下的群名（存档时抓到的），没有才现查
    const from = it.srcGroupName ? groupLabel(it.srcGroup, it.srcGroupName) : lab(it.srcGroup);
    const who = String(it.senderName || '').trim() || '未知';
    // 逐条汇报时把「这条对应上面第几张卡片」写出来 —— 引用哪条聊天记录一眼就对得上
    const card = i < pushed ? ` · 📎 上面第 ${i + 1} 张卡片` : '';
    lines.push(`【${it.id}】来源 ${from}${card}`);
    lines.push(`     ${who} · ${Number(it.count) || 0} 条 · 收到 ${shortTime(it.at)}`);
    // 导向群**必须写群名**（主人 2026-10-04：不要只标记群号），且列全每个候选群
    const to = (it.targets || []).map(lab).join('、');
    if (to) lines.push(`     → ${to}`);
    // 导向群里已经有这份内容的，压根不列进备选 —— 但要说明一句，
    // 免得主人以为"我配的群怎么少了一个"、或者拿群号去点一个已经被跳过的群。
    const skip = (it.dupes || []).map(lab).filter(Boolean);
    if (skip.length) lines.push(`     （${skip.join('、')} 里已经有这条了，没列进备选）`);
    const pv = previewOf(it.text, s.previewLines, s.previewChars).map(tidyPreviewLine).filter(Boolean);
    if (pv.length) {
      for (const l of pv) lines.push(`     ${l}`);
    } else {
      lines.push('     （这条没有可预览的文字）');
    }
    lines.push('');
  }
  const first = items[0] || {};
  const oneGroup = (first.targets || [])[0];
  lines.push(oneGroup
    ? `只想发其中一个群：${cmdOf(first)} ${oneGroup}`
    : `只想发其中一个群：${cmdOf(first)} 加上群号`);
  lines.push(`不想要的丢掉：\\不转 ${first.id ?? 1} ｜ 看全部：\\转发状态 ｜ 说明：\\转发帮助`);
  return lines.join('\n');
}

/** 发完之后的回执（合并转发 / 纯文本回退各报一行）。labelOf 传了就以群名为准。 */
export function renderSendReceipt(results, labelOf = null) {
  const lab = typeof labelOf === 'function' ? labelOf : null;
  const ok = results.filter((r) => r.ok);
  const lines = [`✅ 屎壳郎：${ok.length}/${results.length} 个目标发送成功`];
  for (const r of results) {
    const to = lab ? lab(r.target) : groupLabel(r.target, r.targetName);
    if (r.ok) {
      lines.push(`· ${to} → ${r.method === 'text' ? '纯文本回退（合并转发失败）' : '合并转发'}`);
      if (r.method === 'text' && r.error) lines.push(`    失败原因：${r.error}`);
    } else {
      lines.push(`· ${to} → ❌ 失败：${r.error || '未知原因'}`);
    }
  }
  return lines.join('\n');
}

/** 主人口令参数：`\转发 2` / `\转发 2 123456` / `\不转` / `\转发`。 */
export function parseRelayArgs(raw) {
  const parts = String(raw ?? '').trim().split(/[\s,，、;；]+/).filter(Boolean);
  let id = 0;
  const groups = [];
  parts.forEach((p, i) => {
    if (i === 0 && /^\d{1,4}$/.test(p)) { id = Number(p); return; }
    if (/^\d{5,12}$/.test(p)) { groups.push(p); return; }
    if (!id && /^\d{1,4}$/.test(p)) id = Number(p);
  });
  return { id, groups };
}

/** `\转发帮助` 的正文。labelOf 同 renderAskText（把群名写出来）。 */
export function renderHelpText(s = {}, labelOf = null) {
  const lab = typeof labelOf === 'function' ? labelOf : (id) => groupLabel(id, '');
  const list = (raw) => {
    const ids = parseGroupIds(raw);
    return ids.length ? ids.map(lab).join('、') : '（未配置）';
  };
  return [
    '📮 屎壳郎 · 用法',
    '',
    '它干什么：盯着「注入群」里任何人发的合并转发，展开存档；',
    '再拿指纹比对每个「导向群」的存档 —— 那边已经有同一条内容就安静，',
    '既不列进备选、也不往那儿发；没有才按下面的模式处理。判定全在本地，0 token。',
    ...(s.pushOriginal !== false
      ? [
        '',
        '扫到新的合并转发时：先把**原始聊天记录卡片**直接私聊发给你，',
        `再发一条带编号的询问 —— 编号顺序 = 卡片顺序（一轮最多先发 ${s.maxPushPerScan || 5} 张）。`
      ]
      : []),
    '',
    `当前模式：${s.mode === 'auto' ? 'auto（薄荷自己判断）' : 'ask（问主人）'}`,
    `注入群：${list(s.injectGroups)}`,
    `导向群：${list(s.targetGroups)}`,
    `存档有效期：${s.ttlHours} 小时 · 每个群最多留 ${s.maxArchivePerGroup} 份`,
    `未回复超时：${Number(s.replyTimeoutMin) > 0
      ? `${s.replyTimeoutMin} 分钟（ask 模式下没回复就自动丢掉，只写日志不打扰你）`
      : '关（一直等你拍板）'}`,
    '暂存编号：每天从 1 重新开始（跨天归零）',
    `暂存去重：${Number(s.dedupeHours) > 0
      ? `同一份内容（指纹相同）${s.dedupeHours} 小时内只问你一次 —— 免得同一份转发被反复扫到、反复问你`
      : '关（同一份内容被反复扫到就会反复问你）'}`,
    `存档目录：${s.archiveDir || '（默认：文档文件夹/转发存档）'}`,
    '',
    '主人口令（都在消息开头打）：',
    '  \\转发 <编号>          发到这条转发列出的全部导向群（已有的群不在里面）',
    '  \\转发 <编号> <群号>    只发指定的那一个群；要是那个群已经有这条内容，',
    '                        会先问你一句 —— 再回一次同样的口令才真发（10 分钟内有效）',
    '  \\转发                 不写编号 = 最新那条',
    '  \\不转 <编号>          丢掉这条（存档留着，不通知）',
    '  \\转发状态 / \\转发清单  看待处理、指纹、存档统计',
    '  \\转发测试             往主人私聊发一条假的合并转发，验证节点格式',
    '  \\转发帮助             这一页',
    '',
    '存档文件：文档文件夹/转发存档/<群号>/<日期>_<指纹8位>.md（薄荷能直接读）'
  ].join('\n');
}

