// 私聊认人（确定性型 / plugins/，纯 hooks）
//
// ── 要解决的问题（用户实测反馈）────────────────────────────────────────────
// 「我叫一心，跟它私聊了好久；另一个人私聊它问『一心是谁』，它不知道。」
// 原因：记忆是**按会话**存的（data/memory/<chatKey>/<uid>.json），一个人的昵称和
// 印象只挂在「private:<他的QQ>」这个目录下。换一个人来私聊，会话变了，机器人
// 就看不到「一心」这个名字 —— 它不是忘了，是那会儿根本没读。
//
// 已有的 plugins/cross-chat-link 解决的是另一半：**同一个人**在群和私聊之间的
// 认知割裂（谁这轮说话，就把他在别处的印象带上）。它按 uid 取，所以
// 「A 来问 B 是谁」这种**按名字反查**它接不住。
//
// ── 做法（两件事，都不经过模型判断）──────────────────────────────────────
//   ① 私聊里贴一小段「我认识的人」名单（昵称 + QQ 号 + 在哪聊过）。
//      名单是这句话能被答上来的前提：模型得先知道"一心"这个名字存在。
//   ② 本轮消息里**提到了**某个它认识的人，就把那个人的卡片展开：
//         【你认识他】幽冥一心（QQ:198549697）
//         · 你们在私聊 198549697 里聊过 4 次，最近一次是 3 天前
//         · 你记得：他让你叫他"一心"…｜爱开玩笑、发图玩梗…｜（最多 maxImpressions 条）
//         · 隐私：这些是私聊内容，**不要**跟现在说话的人复述…
//      并且点明"现在说话的是另一个人"，否则模型会把两个人当成同一个人。
//
// 为什么是 plugins/ 而不是 skills/：
//   需求是"它得知道/必须知道"，不是"它可以选择去查"。放 skills/ 要注册工具、由
//   模型决定何时调用 —— 用户问「一心是谁」时模型可能想不到去调，就是这次要修的
//   毛病本身。放 plugins/ 是每轮确定性注入，模型想忽略也忽略不掉。
//
// 不变量（重要）：
//   · 只读 data/memory 下的**小文件**（按人印象）和 data/messages 的**尾部**；
//     大文件（本机群记录 500KB+）不做整段解析，超限直接跳过。
//   · 一个人都没认出来 → 一个字都不加，绝不凭空编。
//   · 所有注入都追加在请求**末尾**（appendDynamicTail），不动 system 前缀，
//     否则系统提示词的前缀缓存会整段失效。
//   · 关掉插件 = 行为完全回到没装之前。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DATA_DIR, getConfig } from '../../src/config.js';
import * as promptCore from '../../src/prompt.js';

/** 本插件目录的绝对路径（Windows 下必须走 fileURLToPath，别手撕 URL 字符串）。 */
const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
/** 排障用：把解析到的路径暴露出来，免得"认不出人"时只能猜。 */
export const __debug = { moduleDir: () => MODULE_DIR };

/**
 * 把卡片注入到请求**末尾**（保住 system 的缓存前缀）。
 *
 * 与 cross-chat-link 同一处理：`appendDynamicTail` 是较新的核心才有的函数，
 * 装到没有它的版本上时命名导入不报错，但调用那一刻会抛 "not a function"，
 * 整个插件静默失效。所以做存在性回退。
 */
const appendToMessages = typeof promptCore.appendDynamicTail === 'function'
  ? promptCore.appendDynamicTail
  : (messages, text) => {
    if (!Array.isArray(messages) || !text) return false;
    const block = `\n\n${String(text).trim()}`;
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const m = messages[i];
      if (!m || m.role !== 'user') continue;
      if (typeof m.content === 'string') { m.content += block; return true; }
      if (Array.isArray(m.content)) { m.content.push({ type: 'text', text: block }); return true; }
    }
    messages.push({ role: 'user', content: block.trim() });
    return true;
  };

/** 出厂默认值（与 plugin.json 的 settings 保持一致，改一处要改两处）。 */
const DEFAULTS = {
  enabled: true,
  maxPeople: 2,
  maxImpressions: 3,
  injectRoster: true,
  rosterMax: 8,
  injectInGroup: false,
  privacyNote: true,
  refreshMinutes: 5
};

/** 名单缓存最长的保鲜时间（设置项 refreshMinutes 是它的常规值）。 */
const MIN_REFRESH_MS = 60 * 1000;
/** 消息文件超过这个大小就只看元信息，不解析（避免每轮读 MB 级文件）。 */
const MESSAGES_MAX_BYTES = 2 * 1024 * 1024;
/** 名字最短 2 个字才参与匹配（1 个字的名字误伤率太高）。 */
const MIN_NAME_LEN = 2;

let api = null;

/** 本轮触发信息（before-context 收集，before-llm-messages 消费，用完即删）。 */
const pendingTrigger = new Map();

/** 名单缓存：{ at, people[], byName: Map }。 */
let rosterCache = { at: 0, people: [], byName: new Map() };

/** 当前设置（插件默认值 ← 用户在设置页改过的值）。 */
function settings() {
  const raw = (api && typeof api.config === 'function' ? api.config() : null) || {};
  const out = { ...DEFAULTS };
  for (const [k, v] of Object.entries(raw)) {
    if (v !== undefined && v !== null) out[k] = v;
  }
  return out;
}

/**
 * 候选数据根目录（按优先级）。
 *
 * QQ Agent 的 DATA_DIR 在不同启动方式下会落到不同位置，同一个安装目录里**两处都
 * 可能有真实数据**（实测：核心配置与聊天记录在 <安装目录>/data，而图片缓存之类
 * 按 <app>/data 硬算的模块写在 resources/app/data）。插件只认一处的话，换一种
 * 启动方式就会「认不出任何人」而且不报错 —— 所以这里把三种可能都列出来，
 * 逐个探测，谁有数据用谁。
 */
function candidateRoots() {
  const out = [];
  const push = (p) => {
    const s = String(p || '').trim();
    if (s && !out.includes(s)) out.push(s);
  };
  // 插件实际位置：<安装目录>/resources/app/plugins/<id>/index.js
  const appDir = path.resolve(MODULE_DIR, '..', '..');        // …\resources\app
  const installDir = path.resolve(MODULE_DIR, '..', '..', '..', '..');  // …\<安装目录>
  push(process.env.QQ_AGENT_DATA_DIR);                 // 显式覆盖（最高优先级）
  push(typeof DATA_DIR === 'string' ? DATA_DIR : '');  // 核心 config.js 的口径
  push(path.join(installDir, 'data'));                 // 打包版的常规位置（实测就是它）
  push(path.join(appDir, 'data'));                     // <app>/data（开发模式直起时在这）
  push(path.join(process.cwd ? process.cwd() : '', 'data'));  // 兜底：工作目录（.bat 直起的场景）
  return out;
}

/** 有 config.json 的那个根 = 正在用的数据根（探测不到就用第一个存在的）。 */
function dataRoot() {
  const roots = candidateRoots();
  for (const r of roots) {
    try { if (fs.existsSync(path.join(r, 'config.json'))) return r; } catch { /* 下一个 */ }
  }
  for (const r of roots) {
    try { if (fs.existsSync(path.join(r, 'memory')) || fs.existsSync(path.join(r, 'messages'))) return r; } catch { /* 下一个 */ }
  }
  return roots[0] || '';
}

/** 每个根下面的 memory/ 与 messages/ 目录（不存在的跳过）。 */
function dataDirs(name) {
  const out = [];
  for (const r of candidateRoots()) {
    const d = path.join(r, name);
    try { if (fs.existsSync(d)) out.push(d); } catch { /* 跳过 */ }
  }
  return out;
}

const memoryDirs = () => dataDirs('memory');
const messagesDirs = () => dataDirs('messages');

/** 读一个小 JSON 文件（失败/超限当没有，绝不抛错影响主流程）。 */
function readJsonFile(file, maxBytes = MESSAGES_MAX_BYTES) {
  try {
    const st = fs.statSync(file);
    if (st.size > maxBytes) return null;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

// ── 文本与名字处理 ────────────────────────────────────────────────────────

const isHan = (ch) => /[\u3400-\u4dbf\u4e00-\u9fff]/.test(ch);

/** 名字归一化：全角转半角、去空白、转小写（匹配时才不会因为空格/大小写漏）。 */
function normName(s) {
  return String(s ?? '')
    .replace(/[\uFF01-\uFF5E]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
    .replace(/[\s\u3000]+/g, '')
    .toLowerCase();
}

/**
 * 从一段话里切出"可能的名字"：连续汉字切成 2~4 字片段，拉丁/数字串整段。
 * 用穷举片段而不是分词 —— 中文昵称没有词典，切片段反而更不容易漏。
 *
 * ⚠️ 短句必须也能切出 2 字片段（「一心是谁」→「一心」）：昵称常常是名字的简称
 *    （「幽冥一心」被叫成「一心」），漏了它等于这个功能只在念全名时可用。
 */
function extractCandidates(text, max = 400) {
  const out = [];
  const han = [];
  const flushHan = () => {
    const s = han.join('');
    han.length = 0;
    if (!s) return;
    for (let i = 0; i + 1 < s.length; i += 1) {
      for (let len = 2; len <= 4 && i + len <= s.length; len += 1) out.push(s.slice(i, i + len));
    }
  };
  const flushLatin = (s) => {
    if (s.length >= 2) out.push(s.toLowerCase());
  };
  let latin = '';
  for (const ch of String(text ?? '')) {
    if (isHan(ch)) {
      flushLatin(latin); latin = '';
      han.push(ch);
      continue;
    }
    flushHan();
    if (/[0-9a-zA-Z_]/.test(ch)) latin += ch;
    else { flushLatin(latin); latin = ''; }
    if (out.length > max) return out.slice(0, max);
  }
  flushHan();
  flushLatin(latin);
  return out.slice(0, max);
}

/**
 * memberNotes：{ [uid]: '别名' } 或 { [uid]: ['别名1','别名2'] } 两种历史形态。
 * 读全局配置（和 cross-chat-link 同一份），字段不存在就当没有 —— 别硬造。
 */
function memberNotes() {
  try {
    const direct = getConfig()?.memberNotes;
    if (direct && typeof direct === 'object') return direct;
  } catch { /* 继续去磁盘上找 */ }
  // 单独 import 本插件做测试时，核心可能读的不是"正在用的"那个 config.json：
  // 逐个候选根翻一遍，谁有 memberNotes 就用谁。
  for (const r of candidateRoots()) {
    const cfg = readJsonFile(path.join(r, 'config.json'), 8 * 1024 * 1024);
    const notes = cfg?.memberNotes;
    if (notes && typeof notes === 'object' && Object.keys(notes).length) return notes;
  }
  return null;
}

// ── 名单（它都认识谁）────────────────────────────────────────────────────

const chatLabel = (chatKey) => {
  const [kind, id] = String(chatKey || '').split(':');
  if (kind === 'group') return `群 ${id}`;
  if (kind === 'private') return `私聊 ${id}`;
  return String(chatKey || '?');
};

/** 印象数组：新形态 { content, createdAt } / 旧形态字符串，都吃。 */
function impressionsOf(data) {
  const list = Array.isArray(data?.impressions) ? data.impressions : [];
  return list
    .map((x) => ({
      text: String(x?.content ?? x ?? '').replace(/\s+/g, ' ').trim(),
      at: Number(x?.createdAt) || 0
    }))
    .filter((x) => x.text)
    .sort((a, b) => a.at - b.at);
}

/** data/memory 下有哪些会话目录（排掉 backups）。所有候选根一起扫。 */
function listMemoryChats() {
  const out = [];
  for (const dir of memoryDirs()) {
    try {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (!e.isDirectory() || e.name === 'backups') continue;
        if (!/^(group|private)_\d+$/.test(e.name)) continue;
        const [kind, id] = e.name.split('_');
        out.push({ chatKey: `${kind}:${id}`, dir: path.join(dir, e.name) });
      }
    } catch { /* 这个根没有记忆目录 */ }
  }
  return out;
}

/**
 * 消息记录里每个人的「最后说话时间 + 昵称」。
 * 用途：印象是**定时巩固**出来的（默认 10 分钟一次），刚私聊完还没印象文件，
 * 这时靠消息记录兜底，否则最常遇到的那个场景（刚聊完就有人来问）反而漏掉。
 */
function lastSeenFromMessages() {
  const map = new Map();
  for (const dir of messagesDirs()) {
    let files = [];
    try { files = fs.readdirSync(dir); } catch { continue; }
    for (const f of files) {
      const m = /^(group|private)_(\d+)\.json$/.exec(f);
      if (!m) continue;
      const data = readJsonFile(path.join(dir, f));
      const list = Array.isArray(data?.messages) ? data.messages : [];
      const chatKey = `${m[1]}:${m[2]}`;
      for (const msg of list) {
        const uid = String(msg?.senderId ?? '').trim();
        if (!uid || uid === 'self') continue;
        const ts = Number(msg?.ts) || 0;
        const cur = map.get(uid) || { uids: new Map(), lastAt: 0, chatKey, name: '' };
        const prev = cur.uids.get(chatKey) || 0;
        cur.uids.set(chatKey, Math.max(prev, ts));
        if (ts >= cur.lastAt) {
          cur.lastAt = ts;
          cur.chatKey = chatKey;
          const nm = String(msg?.senderName ?? '').trim();
          if (nm) cur.name = nm;
        }
        map.set(uid, cur);
      }
    }
  }
  return map;
}

/**
 * 构建名单：扫描 data/memory/<chatKey>/<uid>.json + data/messages/*.json。
 * 纯本地小文件读；失败只会让名单小一点，不会报错。
 */
function buildRoster() {
  const byUid = new Map();
  const seen = lastSeenFromMessages();

  for (const chat of listMemoryChats()) {
    let files = [];
    try { files = fs.readdirSync(chat.dir); } catch { continue; }
    for (const f of files) {
      const m = /^(\d+)\.json$/.exec(f);
      if (!m) continue;
      const uid = m[1];
      const data = readJsonFile(path.join(chat.dir, f), 512 * 1024);
      if (!data) continue;
      const cur = byUid.get(uid) || { uid, name: '', aliases: [], impressions: [], chats: new Map(), lastAt: 0 };
      const nm = String(data?.name ?? '').trim();
      if (nm) cur.name = nm;
      for (const imp of impressionsOf(data)) {
        cur.impressions.push(imp);
        if (imp.at > cur.lastAt) cur.lastAt = imp.at;
      }
      const t = Number(data?.updatedAt) || 0;
      if (t > cur.lastAt) cur.lastAt = t;
      const prev = cur.chats.get(chat.chatKey) || { lastAt: 0, impressions: 0 };
      cur.chats.set(chat.chatKey, {
        lastAt: Math.max(prev.lastAt, t || 0),
        impressions: prev.impressions + impressionsOf(data).length
      });
      byUid.set(uid, cur);
    }
  }

  // 消息记录兜底：没印象文件、但聊过的人也要进名单
  for (const [uid, info] of seen) {
    const cur = byUid.get(uid) || { uid, name: '', aliases: [], impressions: [], chats: new Map(), lastAt: 0 };
    if (!cur.name && info.name) cur.name = info.name;
    if (info.lastAt > cur.lastAt) cur.lastAt = info.lastAt;
    for (const [chatKey, ts] of info.uids) {
      const prev = cur.chats.get(chatKey) || { lastAt: 0, impressions: 0 };
      cur.chats.set(chatKey, { lastAt: Math.max(prev.lastAt, ts), impressions: prev.impressions });
    }
    byUid.set(uid, cur);
  }

  // 别名（memberNotes）合并进来
  const notes = memberNotes();
  if (notes && typeof notes === 'object') {
    for (const [uid, val] of Object.entries(notes)) {
      const cur = byUid.get(String(uid));
      if (!cur) continue;
      const arr = Array.isArray(val) ? val : [val];
      cur.aliases = arr.map((x) => String(x ?? '').trim()).filter(Boolean);
    }
  }

  // 排序 + 去重印象
  const people = [...byUid.values()]
    .filter((p) => p.chats.size > 0 || p.impressions.length > 0)
    .map((p) => {
      const imps = [];
      const seenText = new Set();
      for (const imp of p.impressions.slice().sort((a, b) => b.at - a.at)) {
        const key = imp.text.slice(0, 40);
        if (seenText.has(key)) continue;
        seenText.add(key);
        imps.push(imp);
      }
      const chats = [...p.chats.entries()]
        .map(([chatKey, info]) => ({ chatKey, ...info }))
        .sort((a, b) => b.lastAt - a.lastAt);
      return { ...p, impressions: imps, chats, lastNameAt: chats[0]?.lastAt || 0 };
    })
    .sort((a, b) => b.lastNameAt - a.lastNameAt);

  // ⚠️ 匹配**不**依赖任何索引表：直接在 people 上比名字。
  //    早先这里维护了一张 name → person 的表，实践证明显式索引比"就地比一遍"更容易
  //    出静默不一致（表里少了某个名字，表现就是"认得出全名却认不出简称"，
  //    而且不报错）。40 来个人，就地比一遍的成本可以忽略。
  const byName = new Map();
  for (const p of people) {
    for (const n of new Set([p.name, ...(p.aliases || [])].map(normName).filter((x) => x.length >= MIN_NAME_LEN))) {
      if (!byName.has(n)) byName.set(n, []);
      byName.get(n).push(p);
    }
  }
  return { people, byName };
}

/** 取名单（带缓存）。force = true 时强制重扫（activate / 诊断用）。 */
function roster({ force = false } = {}) {
  const everyMs = Math.max(MIN_REFRESH_MS, (Number(settings().refreshMinutes) || 5) * 60 * 1000);
  const now = Date.now();
  const fresh = rosterCache.people.length > 0
    && now - rosterCache.at < everyMs
    // 缓存里必须已经有"带名字的人"，否则一律重扫：空名单会让功能静默失效
    && rosterCache.people.some((p) => normName(p.name).length >= MIN_NAME_LEN);
  if (!force && fresh) return rosterCache;
  const built = buildRoster();
  rosterCache = { at: now, ...built };
  return rosterCache;
}

// ── 匹配与卡片 ────────────────────────────────────────────────────────────

/**
 * 本轮消息提到了谁。
 *
 * 命中条件：某人**名字或别名的任意后缀**（≥2 字）作为连续片段出现在消息里。
 * 为什么要后缀而不只是全名：昵称常常是名字的简称 ——「幽冥一心」平时被叫「一心」，
 * 群里其他人也这么叫。只比全名的话，用户最常见的那句「一心是谁」就匹配不上。
 * 长名字优先（「幽冥一心」比「一心」更具体），同一个人只出一张卡。
 */
function findMentioned(text, { excludeUid = '', limit = 2 } = {}) {
  const raw = String(text ?? '');
  if (!raw.trim()) return [];
  const norm = normName(raw);
  const cands = new Set(extractCandidates(raw));
  const inText = (n) => cands.has(n) || norm.includes(n);
  const r = roster();

  const hits = [];
  for (const p of r.people) {
    const names = new Set([p.name, ...(p.aliases || [])].map(normName).filter((n) => n.length >= MIN_NAME_LEN));
    let best = '';
    for (const full of names) {
      // 全名整体命中；否则从长到短试后缀（"一心" 来自 "幽冥一心"）
      if (inText(full)) { if (full.length > best.length) best = full; continue; }
      for (let i = 1; i + MIN_NAME_LEN <= full.length; i += 1) {
        const tail = full.slice(i);
        if (tail.length > best.length && inText(tail)) best = tail;
      }
    }
    if (best) hits.push({ person: p, hit: best });
  }

  hits.sort((a, b) => (b.hit.length - a.hit.length) || (b.person.lastNameAt - a.person.lastNameAt));
  const out = [];
  for (const h of hits) {
    if (String(h.person.uid) === String(excludeUid)) continue;   // 本人的卡对他自己没意义
    if (out.some((o) => o.uid === h.person.uid)) continue;
    out.push({ ...h.person, __hitName: h.hit });
    if (out.length >= Math.max(1, limit)) break;
  }
  return out;
}

/** 「3 天前 / 今天 03:12」这种人话时间，比时间戳省 token 也好懂。 */
function humanWhen(ts) {
  const t = Number(ts) || 0;
  if (!t) return '';
  const d = new Date(t);
  const now = new Date();
  const days = Math.floor((now.getTime() - t) / 86400000);
  const hhmm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  if (days <= 0) return `今天 ${hhmm}`;
  if (days === 1) return `昨天 ${hhmm}`;
  if (days < 30) return `${days} 天前`;
  return `${Math.floor(days / 30)} 个月前`;
}

/**
 * 一个人的卡片。
 *
 * 语义要点：现在说话的人**不是**卡片里的人，所以必须写清"这是你知道的另一个人"，
 * 并给出隐私约束 —— 否则模型很容易把两个人的记忆搅在一起，或把 A 的私聊内容
 * 当谈资讲给 B 听。
 */
function buildPersonCard(person, { currentChatKey, s }) {
  const name = person.name || `QQ:${person.uid}`;
  const lines = [`【你认识他】${name}（QQ:${person.uid}）`];

  const chats = (person.chats || []).filter((c) => c.chatKey !== currentChatKey);
  const where = chats.slice(0, 2).map((c) => {
    const when = humanWhen(c.lastAt);
    return `${chatLabel(c.chatKey)}${when ? `（最近 ${when}）` : ''}`;
  });
  if (where.length) lines.push(`· 你们在 ${where.join('、')} 聊过`);

  const imps = (person.impressions || []).slice(0, Math.max(1, Number(s.maxImpressions) || 3));
  if (imps.length) lines.push(`· 你记得他：${imps.map((x) => x.text.slice(0, 80)).join('｜')}`);
  if (!where.length && !imps.length) pointsOfInterestFallback(lines, person);

  lines.push(`· 注意：现在跟你说话的是**另一个人**，不是他。可以承认你认识他、他是什么样的人，`
    + '但**别**说"他最近找过我""我们刚聊过"这类他没主动说过的近况。');
  if (s.privacyNote !== false) {
    lines.push('· 隐私：你和他私聊过的内容不要讲给现在这个人听，也别报出你们聊了什么；他要问，让他自己去问本人。');
  }
  return lines.join('\n');
}

function pointsOfInterestFallback(lines, person) {
  const chats = (person.chats || []).slice(0, 1);
  if (chats.length) lines.push(`· 你们在 ${chatLabel(chats[0].chatKey)} 聊过`);
}

/** 私聊里的「我认识的人」清单：只说昵称和 QQ 号，不带任何内容。 */
function buildRosterLine(s) {
  const r = roster();
  const limit = Math.max(0, Number(s.rosterMax) || 12);
  if (!limit || !r.people.length) return '';
  const list = r.people.slice(0, limit).map((p) => {
    const name = p.name || `QQ:${p.uid}`;
    const where = p.chats?.[0] ? chatLabel(p.chats[0].chatKey) : '';
    return where ? `${name}(QQ:${p.uid}，${where})` : `${name}(QQ:${p.uid})`;
  });
  const more = r.people.length > limit ? `，另外还有 ${r.people.length - limit} 位没列` : '';
  return [
    `【你私聊过的人】共 ${r.people.length} 位：${list.join('；')}${more}。`,
    '· 名单只是"你认识谁"。有人问起名单里的人，你已经认识他，不要反问"这是谁"。',
    '· 名单里的人的私聊内容属于隐私：可以认人，不要转述他们说过的话。'
  ].join('\n');
}

// ── 生命周期 ──────────────────────────────────────────────────────────────

export function setup(a) {
  api = a;
}

/** 生效：先把名单扫出来（顺带给启动日志一个可核对的数字）。 */
export function activate() {
  const s = settings();
  if (s.enabled === false) return;
  try {
    const r = roster({ force: true });
    api?.log?.(`私聊认人已启用：名单里 ${r.people.length} 人（数据根 ${dataRoot()}）`);
  } catch (error) {
    api?.warn?.('名单初始化失败：', error?.message ?? error);
  }
}

/** 关闭：只清缓存，磁盘上的记忆一个字都不动。 */
export function deactivate() {
  pendingTrigger.clear();
  rosterCache = { at: 0, people: [], byName: new Map() };
}

/** 开关（技能页的启用/停用走这里，不是自己维护一个 enabled 影子开关）。 */
export function available() {
  return settings().enabled !== false;
}

// ── 钩子 ──────────────────────────────────────────────────────────────────

export const hooks = {
  /** 记下这轮说了什么、谁在说（before-llm-messages 拿不到这两个）。 */
  async 'before-context'(ctx = {}) {
    try {
      const entries = Array.isArray(ctx.triggerEntries) ? ctx.triggerEntries : [];
      const texts = [];
      const speakers = [];
      for (const e of entries) {
        const t = String(e?.text ?? '').trim();
        if (t) texts.push(t);
        const uid = String(e?.senderId ?? '').trim();
        if (uid && uid !== 'self' && !speakers.includes(uid)) speakers.push(uid);
      }
      pendingTrigger.set(String(ctx.sessionId || ctx.chatKey || ''), {
        chatKey: String(ctx.chatKey || ''),
        kind: String(ctx.kind || ''),
        speakerId: speakers[speakers.length - 1] || '',
        text: texts.join('\n').slice(0, 1200)
      });
      if (pendingTrigger.size > 50) pendingTrigger.delete(pendingTrigger.keys().next().value);
    } catch { /* 收集失败只是这轮不带卡片 */ }
  },

  /** 注入：私聊名单（可关）+ 被提到的人的卡片。 */
  async 'before-llm-messages'(ctx = {}) {
    const s = settings();
    if (s.enabled === false) return;

    const key = String(ctx.sessionId || ctx.chatKey || '');
    const info = pendingTrigger.get(key) || null;
    pendingTrigger.delete(key);

    const chatKey = String(ctx.chatKey || info?.chatKey || '');
    const kind = String(ctx.kind || info?.kind || (chatKey.startsWith('group:') ? 'group' : 'private'));
    const isPrivate = kind === 'private' || chatKey.startsWith('private:');
    if (!isPrivate && s.injectInGroup !== true) return;   // 群里默认不认人（人多、噪声大）

    const blocks = [];
    if (isPrivate && s.injectRoster !== false) {
      const line = buildRosterLine(s);
      if (line) blocks.push(line);
    }

    const text = info?.text || '';
    const mentioned = text
      ? findMentioned(text, { excludeUid: info?.speakerId || '', limit: Math.max(1, Number(s.maxPeople) || 2) })
      : [];
    for (const person of mentioned) {
      blocks.push(buildPersonCard(person, { currentChatKey: chatKey, s }));
    }

    if (!blocks.length) return;   // 没认出来就不加字
    appendToMessages(ctx.messages, blocks.join('\n\n'));
  }
};

// ── 能力：排查用（不参与正常对话）────────────────────────────────────────

export const providers = {
  /**
   * 问「它到底认识谁 / 认得某某吗」。
   * args: { uid?, query?, refresh? }
   *   uid     —— 直接看某个 QQ 号的资料
   *   query   —— 用一句模拟的话走一遍真实匹配逻辑
   *   refresh —— 强制重扫名单
   */
  'memory.known-people': (args = {}) => {
    try {
      const r = roster({ force: args?.refresh === true });
      const uid = String(args?.uid ?? '').trim();
      const query = String(args?.query ?? '').trim();
      if (uid) {
        const person = r.people.find((p) => String(p.uid) === uid) || null;
        return { ok: true, count: r.people.length, found: Boolean(person), uid, person };
      }
      if (query) {
        const matched = findMentioned(query, { limit: 5 });
        return {
          ok: true,
          count: r.people.length,
          query,
          matched: matched.map((p) => ({ uid: p.uid, name: p.name, hit: p.__hitName })),
          // 排障用：切出来的候选片段 + 名单里的名字（"认得全名却认不出简称"时靠它定位）
          debug: {
            candidates: extractCandidates(query).slice(0, 40),
            names: r.people.map((p) => p.name).filter(Boolean).slice(0, 60)
          }
        };
      }
      return {
        ok: true,
        count: r.people.length,
        dataRoot: dataRoot(),
        candidates: candidateRoots(),
        people: r.people.map((p) => ({
          uid: p.uid,
          name: p.name,
          aliases: p.aliases,
          chats: p.chats.map((c) => c.chatKey),
          impressions: p.impressions.length,
          lastAt: p.lastNameAt
        }))
      };
    } catch (error) {
      return { ok: false, error: String(error?.message ?? error) };
    }
  }
};
