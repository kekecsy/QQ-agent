// 游戏王查卡快车道 —— 判定与取数逻辑（**全程不碰模型**）。
//
// ── 为什么要把它做成插件而不是技能 ────────────────────────────────────────
//   「这张卡什么效果」的答案**本来就写在卡面上**，是查得到的确定数据，不是生成的。
//   让模型去"复述"它，只会同时买到三样坏东西：慢、贵、可能记错。
//   而"要不要查 / 查哪张 / 查到之后怎么讲"在过去之所以只能交给模型，是因为
//   要理解人话 —— 本文件证明这件事**有一半不需要**（见下面那条关键设计）。
//   真正需要理解场景的（能不能发动 / 会不会被无效 / 连锁怎么处理）仍然不拦，
//   交给 skills/ygo-ruling（LLM 型，注册工具），本插件只吃"只问卡面"的那部分。
//
// ── 关键设计：不建卡名索引，用卡库反推确定性 ──────────────────────────────
//   "这句话里哪几个字是卡名"是不可解的字符串问题：几万张卡，每张都有中文名 /
//   简中名 / MD 名 / 民翻名 / CNOCG 名 / 日文名 / 英文名 / 密码，还夹中文虚词。
//   本地做子串匹配的话「龙」会命中几百张、还和"恐龙""龙虾"打架 —— 这就是
//   为什么原来只能交给模型。
//
//   但换个方向就有解：「**整句话**像不像一个卡名」是可以验的。做法是
//   ① 把消息去噪（拆掉 @ / 寒暄 / 疑问语气 / 标点）成一个候选查询串；
//   ② 把它**整串**丢给卡库（ygocdb，实测 80~450ms）；
//   ③ 用返回的匹配质量反推"用户问清楚了没有"：
//        · 有别名与查询串**精确相等**  → 问清楚了，直答；
//        · 候选收敛到少数几张        → 按设置自己挑一张（并在回复里写明按哪张理解）或列清单问问；
//        · 对不上 / 候选一大片       → **一律放行给模型**（宁可慢，不乱答）。
//   于是既不用维护几 MB 的本地卡表，也几乎不可能答错 —— 因为"对不对"是卡库说的，
//   不是我们猜的。副作用只是每条"像查卡"的消息多一次 HTTP（无 token）。
//
// ── 可测性 ────────────────────────────────────────────────────────────────
//   本文件不 import 项目的任何东西（除了常量），fetch 由外部注入 ——
//   所以可以脱离 Electron 直接跑（见 SKILL.md / README.md 的离线自测做法）。
//   卡名归一化 / 打分与 skills/ygo-ruling 保持**同一套规则**：两处判断必须一致，
//   否则会出现"技能说是这张、插件说是那张"的分裂。

const YGOCDB_API = 'https://ygocdb.com/api/v0/';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

/** 一次查询最多缓存多少条（LRU 上限，防内存无限涨）。 */
const CACHE_MAX = 200;

/** 寒暄 / 请求前缀。出现在候选串里一律去掉 —— 它们永远不可能是卡名的一部分。 */
const POLITE_WORDS = [
  '请问', '问一下', '问下', '问一问', '帮我', '帮忙', '麻烦', '劳驾',
  '我想知道', '想知道', '查一下', '查下', '查一查', '查查', '搜一下', '搜下', '搜一搜',
  '看一下', '看下', '找一下', '找下', '给我看看', '讲讲', '说说',
  '这张卡', '这张', '这卡', '那张卡', '那张', '那个卡', '这个名字', '名字', '卡片', '卡名'
];

/**
 * 判例 / 推理意图 —— **命中就绝不抢答**。
 *
 * 这是本插件最重要的安全阀：这些词说明用户在问"场景怎么处理"，而不是"卡面写了什么"，
 * 必须交给模型（ygo-ruling 会去取 Lua 脚本）。判断放在去噪**之前**，因为去噪会把
 * 这些词当语气词吃掉（「能不能发动」去掉"发动"就剩「能不能」了）。
 */
const RULING_RE = /能不能|可不可以|会不会|能否|是否|怎么|如何|为什么|为啥|什么情况|连锁|时点|时机|无效|发动|抗性|判例|裁定|规则|调整|伤害步骤|优先权|取对象|指定|离场|被破坏|对象|同时|回合|优先|bug/i;

// ── 卡名归一化 / 打分（与 skills/ygo-ruling 同源，改动必须同步）──────────────

/** 归一名：去掉 @、书名号、引号、空白，转小写。 */
export function normName(s) {
  return String(s ?? '')
    .trim()
    .replace(/^[@\s]+/, '')
    .replace(/[《》「」“”‘’]/g, '')
    .replace(/\s+/g, '')
    .toLowerCase();
}

/** 一张卡的全部可匹配名字（含密码；cid 不参与，卡库偶尔不回）。 */
export function cardAliases(card) {
  return [card.cn_name, card.sc_name, card.md_name, card.nwbbs_n, card.cnocg_n, card.jp_name, card.en_name, card.id]
    .filter(Boolean)
    .map(String);
}

/**
 * 匹配打分：**任一别名**与搜索词完全相等 = 100；候选名包含搜索词 = 60；搜索词包含候选名 = 20。
 * 必须把所有别名都算进去 —— 实测「黑魔导」查的是「黑魔术师」（命中民翻别名），
 * 只看 cn_name 会算成 0 分，把一张完全确定的卡误判成"对不上"而白白放行给模型。
 */
export function scoreCard(card, token) {
  const target = normName(token);
  if (!target) return { score: 0, alias: '', onPrimary: false, exactWord: false };
  // 主名（中文名 / 简中 / MD）—— 同分时用它打破平局（不改变 score 语义，只影响排序）。
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
    // 「整词命中」：查询词是候选名里**独立的一个词**（卡名惯用空格分词）。
    // 例：查「霍普」——「No.39 希望皇 霍普」里「霍普」自成一段 ✅；而「剑斗兽 霍普洛姆斯」
    // 里只是半个词 ❌。
    const word = String(candidate).split(/[\s·・]+/).some((w) => normName(w) === target);
    const prim = primary.has(n);
    // 同一张卡内部选"最能代表它"的那个别名：分高者胜；同分则 整词命中 > 部分命中，
    // 再同则 主名 > 别名。**只影响别名选择与同分排序，不改变 score 语义**。
    const cur = [s, word ? 1 : 0, prim ? 1 : 0];
    const curBest = [best, exactWord ? 1 : 0, onPrimary ? 1 : 0];
    if (cur[0] > curBest[0]
      || (cur[0] === curBest[0] && (cur[1] > curBest[1] || (cur[1] === curBest[1] && cur[2] > curBest[2])))) {
      best = s; alias = String(candidate); onPrimary = prim; exactWord = word;
    }
  }
  return { score: best, alias, onPrimary, exactWord };
}

/** needle 的字符是否按顺序出现在 hay 里（允许中间跳过字符）。 */
export function isSubsequence(needle, hay) {
  let i = 0;
  for (let j = 0; j < hay.length && i < needle.length; j++) if (hay[j] === needle[i]) i += 1;
  return i === needle.length;
}

/**
 * 「跳字缩写」弱匹配：用户把卡名中间的**几个字跳掉**了（「阁楼妖」←【阁楼·上的·妖·怪】）。
 *
 * 为什么单列一条规则：现有打分只看"连续子串"，而跳字缩写**一个字都对不上连续关系** ——
 * 「阁楼妖」对【阁楼上的妖怪】算 0 分，于是整条消息被放行给模型（实测 2026-10-05 踩到：
 * 私聊「查卡 阁楼妖」被放行，模型花了 1 分 44 秒才问出"你说的是这张吗"）。
 *
 * 安全性靠四道约束（缺一不可），且**只用于"提问"，绝不用于笃定回答**（见 decide）：
 *   ① 只对含中文的查询启用 —— 英文按字符比太松；
 *   ② 首字必须相同 —— 缩写几乎总保留首字，这一条就挡掉了绝大多数误判；
 *   ③ 别名的长度上限 —— 别名不能比查询长太多（跳过比例有上限），
 *      否则「龙」这种会吸住任何带龙的长名字；
 *   ④ 覆盖率下限 —— 查询至少要占别名 40% 的字，不能"三个字套住十个字"。
 * 另外调用方还要求**卡库对原词只回了 ≤2 条**（见 decide），即"候选本来就已经收敛"。
 *
 * @returns {{alias:string, ratio:number}|null}
 */
export function weakMatch(card, token) {
  const target = normName(token).replace(/\s+/g, '');
  if (!/[\u3400-\u9fff]/.test(target)) return null;
  if (target.length < 2) return null;
  let best = null;
  for (const candidate of cardAliases(card)) {
    const n = normName(candidate).replace(/\s+/g, '');
    if (!n || n.length <= target.length) continue;
    if (n[0] !== target[0]) continue;
    const ratio = target.length / n.length;
    if (ratio < 0.4) continue;
    if (n.length > target.length * 2 + 2) continue;
    if (!isSubsequence(target, n)) continue;
    if (!best || ratio > best.ratio) best = { alias: String(candidate), ratio };
  }
  return best;
}

/**
 * 去掉中文虚词得到"核心词"，只在结果可疑地少时用来补搜一次。
 * 实测：「真红眼的黑龙」只命中「真红眼黑龙剑」（它的**简中名**就叫「真红眼的黑龙剑」，
 * 用户的词是它的前缀 → 60 分假阳性），去掉「的」补搜「真红眼黑龙」才对。
 * ⚠️ 只对含中文的查询做这件事 —— 对英文名去掉空格（"Ash Blossom" → "AshBlossom"）
 * 会搜出完全无关的乱码记录，反而比原词更糟。返回空串 = 不要补搜。
 */
export function coreKeyword(s) {
  const str = String(s ?? '');
  if (!/[\u3400-\u9fff]/.test(str)) return '';
  return str.replace(/[的之·・]/g, '').trim();
}

/**
 * 前缀截断形式：把查询**尾部的字**逐个去掉（保留到 2 个字为止）。
 *
 * 为什么需要：卡库自己的模糊搜索只在"别名包含查询串"这类关系上有效，用户把**最后一个字
 * 说岔了**（或记错成同义字）时，它会静默地什么都不给。实测 2026-10-05：
 *   「阁楼妖」→ 卡库只回 1 条（阁楼上的妖怪），**完全没有**用户真正要的【莫忘阁楼怪】；
 *   「阁楼」  → 两条都给（阁楼上的妖怪 + 莫忘阁楼怪）。
 * 而那张卡的任何别名里都没有「妖」字（cn 莫忘阁楼怪 / 简中 冥铭途・楼中怪 /
 * CNOCG 无忘阁楼魂灵），所以这不是"别名没匹配上"，而是"这个词本身查不到它"。
 * 去掉尾字再搜一次，就能把它捞回候选里 —— 然后**问用户是哪张**（见 decide）。
 *
 * ⚠️ 只截 1~2 个字。截太多会让「青眼白龙好帅啊」这种闲聊也命中一堆卡。
 */
export function truncatedForms(query) {
  const s = normName(query).replace(/\s+/g, '');
  const out = [];
  for (let cut = 1; cut <= 2; cut += 1) {
    const v = s.slice(0, s.length - cut);
    if (v.length >= 2) out.push(v);
  }
  return [...new Set(out)];
}

/**
 * 宽松命中：卡库对某个（截断后的）搜索词**恰好只回一张**时，能不能认这张？
 *
 * 背景：采纳补搜结果的门槛是「卡名包含搜索词」（score ≥ 60）。但卡库自己还会做
 * **多片段模糊匹配**，实测（2026-10-06）：
 *   搜「冥铭途阁楼」→ 只回 1 条【莫忘阁楼怪】（用户把简中名「冥铭途・楼中怪」的
 *   前缀和中文名「莫忘阁楼怪」的中段拼在了一起）—— 而这张卡的任何别名都不包含
 *   「冥铭途阁楼」这个连续串，所以 0 分被门槛筛掉 → 整条放行给模型。
 * 这时"卡库只回一张"本身就是很强的信号（它宁可回 0 条也不硬凑：实测
 * 「青眼白龙羽毛扫」「我想吃火锅」都回 0 条）。
 *
 * 四道闸缺一不可（前两道挡"卡库硬凑"，后两道挡"常用词巧合"）：
 *   ① 卡库对这个词**恰好**回 1 条（0 条 = 没线索，多条 = 歧义，都不认）
 *   ② form 的**每个字**都出现在这张卡的名字里（「这把输」→【同盟运输车】缺"这把"→ 不认）
 *   ③ form 与卡名至少有一段 **≥2 字的连续公共子串**（「明天」←【骸骨天使】只共用一个"天" → 不认）
 *   ④ form **≥3 个字**（两字的常用词撞上卡名的概率太高，实测「明天有空」→「明天」→【骸骨天使】）
 */
export function looseMatch(card, form) {
  const f = normName(form);
  if (f.length < 3) return false;
  const names = cardAliases(card)
    .map((a) => String(a).trim())
    .filter((a) => a && !/^\d+$/.test(a))   // 密码不参与"像卡名"的判断
    .map(normName)
    .filter(Boolean);
  if (!names.length) return false;
  const pool = names.join('');
  if (![...new Set(f.split(''))].every((c) => pool.includes(c))) return false;   // ②
  return names.some((n) => commonRun(f, n) >= 2);                                 // ③
}

/** 两个字符串的最长连续公共子串长度（卡名都很短，朴素 O(n·m) 足够）。 */
export function commonRun(a, b) {
  let best = 0;
  for (let i = 0; i < a.length; i += 1) {
    for (let j = 0; j < b.length; j += 1) {
      let k = 0;
      while (a[i + k] && a[i + k] === b[j + k]) k += 1;
      if (k > best) best = k;
    }
  }
  return best;
}

/** ygocdb 原始记录 → 我们要的形状（与 skills/ygo-ruling 的 normalizeCard 对齐）。 */
export function normalizeCard(raw) {
  const text = raw?.text || {};
  return {
    id: raw?.id !== undefined && raw?.id !== null ? String(raw.id) : '',
    cn_name: raw?.cn_name || text?.name || raw?.sc_name || raw?.md_name || '',
    sc_name: raw?.sc_name || '',
    md_name: raw?.md_name || '',
    nwbbs_n: raw?.nwbbs_n || '',
    cnocg_n: raw?.cnocg_n || '',
    jp_name: raw?.jp_name || '',
    en_name: raw?.en_name || '',
    types: text?.types || '',
    // ⚠️ 卡库的效果文本是混合换行（实测「灰流丽」的正文里带 \r\n）——
    //    统一成 \n，否则同一段卡文在 QQ 里可能出现两种行距。
    pdesc: String(text?.pdesc || '').replace(/\r\n?/g, '\n'),
    desc: String(text?.desc || '').replace(/\r\n?/g, '\n'),
    faqcount: raw?.faqcount ?? ''
  };
}

/** 类型串是带换行的（`[怪兽|效果]\n炎/战士`）→ 压成一行。 */
function compactTypes(t) {
  return String(t || '').replace(/\s*\n\s*/g, ' ').trim();
}

// ── 从消息里榨出"疑似卡名" ────────────────────────────────────────────────

/** 逗号分隔的意图词串 → 数组。 */
export function parseIntentWords(raw) {
  return String(raw ?? '')
    .split(/[,，\n]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * 把一条群消息去噪成候选查询串。
 *
 * @param {string} rawText  消息原文（可能含 CQ 码 / @ 片段）
 * @param {object} opts
 * @param {string[]} opts.intentWords   没 @ 她时认的触发词（剥掉用）
 * @param {boolean} opts.lenient        true = 她**已经被 @ 到**（或私聊），不需要触发词
 * @param {boolean} opts.requireIntent  true = 没被 @ 到就必须带触发词才认；
 *                                      false = 免 @ 免触发词也放行到查库那一步
 *                                      （groupTrigger='any'，见 DEFAULTS 与 index.js 的说明）
 * @param {number} opts.minLen          去噪后最少几个字
 * @returns {string|null} null = 这条消息不像查卡，**不要联网**，原样放行给模型
 */
export function extractQuery(rawText, { intentWords = [], lenient = false, requireIntent = true, minLen = 2 } = {}) {
  let t = String(rawText ?? '');
  if (!t) return null;

  // ① 判例意图先判（必须在去噪之前 —— 去噪会把这些词当语气吃掉）
  if (RULING_RE.test(t)) return null;

  // ② 去 CQ 码 / 媒体占位（图片、语音这些没有可查的文本）
  t = t.replace(/\[CQ:[^\]]*\]/g, ' ');
  t = t.replace(/\[[^\]]{0,24}?(图片|表情|语音|视频|文件|动画|名片|转发|戳一戳)[^\]]{0,24}?\]/g, ' ');
  // ③ 去 @ 昵称。**必须在长度闸之前**：@ 段在文本里是 "@薄荷 羽毛扫" 这种带空格的
  //    形式，留着会让下面"中文里混空格 = 被拆过词"那条闸把正常的查卡请求误杀
  //    （实测：只留空格不清 @，整条 "@她 羽毛扫" 会被判成不像卡名而放行）。
  t = t.replace(/@[^\s@]{0,24}/g, ' ');

  // ④ 触发词：命中就剥掉，并记住"确实是要查卡"
  let hitIntent = false;
  for (const w of intentWords) {
    if (w && t.includes(w)) {
      hitIntent = true;
      t = t.split(w).join(' ');
    }
  }
  // ⑤ 既没被 @ 到、又没触发词 → 不抢答（群里闲聊不该被丢去查卡库）。
  //    groupTrigger='any' 时 requireIntent=false：连这道闸也不设，让群里任何一条
  //    "长得像卡名"的消息都走到查库那一步。**这一步是安全的**，因为真正决定要不要
  //    开口的是下游卡库的匹配质量 —— 对不上（闲聊、乱串）一律原样放行给模型；
  //    判例词更是在第 ① 步就返回 null，连 HTTP 都不会发。
  if (!lenient && requireIntent && !hitIntent) return null;

  // ⑥ 去寒暄 / 请求语
  for (const w of POLITE_WORDS) t = t.split(w).join(' ');

  // ⑦ 去引号书名号、标点、句末语气词
  t = t.replace(/[《》「」『』“”‘’"'（）()【】\[\]{}]/g, '');
  t = t.replace(/[？?。.!！~～…、，,;；:：]+/g, ' ');
  t = t.trim().replace(/[吗呢啊呀吧哦咯嘛呗哟欸诶]/g, '');
  t = t.replace(/\s+/g, ' ').trim();
  if (!t) return null;

  // ⑧ 长度闸：单字（"龙""神"）会和几百张卡撞；太长肯定不是卡名
  const plain = t.replace(/\s/g, '');
  if (plain.length < Math.max(1, Number(minLen) || 2)) return null;
  const asciiOnly = /^[\x20-\x7f]+$/.test(t);
  if (asciiOnly) {
    if (t.length > 40) return null;          // 英文卡名 / 密码
  } else {
    if (plain.length > 24) return null;       // 中文：超过 24 字不像卡名
    if (/\s/.test(t)) return null;            // 中文里混空格 = 被拆过词，不像卡名
  }
  return t;
}

// ── 引擎 ──────────────────────────────────────────────────────────────────

const DEFAULTS = {
  pickMode: 'auto',
  autoPickMax: 3,
  maxCandidates: 10,
  minQueryLen: 2,
  timeoutMs: 6000,
  cacheTtlMin: 10,
  cooldownMs: 1500,
  showAlias: false,
  onlyWhenIdle: true,
  // 跳字缩写（「阁楼妖」→【阁楼上的妖怪】）时：卡库已经收敛到很少几张，就问一句
  // 「你说的是这张吗」而不是闭嘴放行给模型。默认开 —— 文案本来就是提问，不笃定。
  askOnWeakMatch: true,
  // 截断补搜后只剩 1 张、且它就是这个名字去掉最后 1~2 个字（「莫忘阁楼妖」→
  // 「莫忘阁楼」→【莫忘阁楼怪】）时，直接把卡面（含效果）给他，别再问"哪一张"。
  // 默认开：这种情况用户意图没有歧义，问一句等于把他要的效果藏起来。
  answerOnSingleTruncate: true,
  // 抢答时是否把卡片插图一起发出去（文字照发，图是额外一条）。
  sendImage: true,
  // 群里没 @ 到她时认不认：'any' = 任何像卡名的消息都试一次查库（默认）；
  // 'at' = 必须 @ 她 / 私聊 / 带触发词。私聊恒认，与本项无关。
  groupTrigger: 'any',
  intentWords: '查卡,查牌,卡查,查一下这张卡,什么效果,效果是什么,是什么卡,卡的效果'
};

export class QuickCard {
  /**
   * @param {object} deps
   * @param {() => object} deps.settings  读插件设置（含 manifest 默认值）
   * @param {Function} deps.fetchImpl     注入的 fetch（走 api.fetch，受 web_fetch 权限门控）
   * @param {Function} [deps.log]
   * @param {Function} [deps.warn]
   */
  constructor({ settings, fetchImpl, log = () => {}, warn = () => {} }) {
    this.settings = settings;
    this.fetch = fetchImpl;
    this.log = log;
    this.warn = warn;
    this.cache = new Map();     // 查询串 -> { at, cards }
    this.lastAt = new Map();    // chatKey -> 上次抢答时间（同群冷却）
    this.counters = { answered: 0, listed: 0, asked: 0, passthrough: 0, noAnswer: 0, errors: 0 };
    this.last = { at: 0, chatKey: '', query: '', result: '', reason: '', chars: 0 };
  }

  opts() {
    const s = this.settings?.() || {};
    const merged = { ...DEFAULTS, ...s };
    return {
      ...merged,
      pickMode: merged.pickMode === 'ask' ? 'ask' : 'auto',
      autoPickMax: Math.max(1, Number(merged.autoPickMax) || 3),
      maxCandidates: Math.min(30, Math.max(1, Number(merged.maxCandidates) || 10)),
      minQueryLen: Math.max(1, Number(merged.minQueryLen) || 2),
      timeoutMs: Math.min(30000, Math.max(500, Number(merged.timeoutMs) || 6000)),
      cacheTtlMin: Math.max(0, Number(merged.cacheTtlMin) || 0),
      cooldownMs: Math.max(0, Number(merged.cooldownMs) || 0),
      groupTrigger: merged.groupTrigger === 'at' ? 'at' : 'any',
      sendImage: merged.sendImage !== false,
      askOnWeakMatch: merged.askOnWeakMatch !== false,
      answerOnSingleTruncate: merged.answerOnSingleTruncate !== false,
      intentWords: parseIntentWords(merged.intentWords)
    };
  }

  stats() {
    return {
      savedAt: new Date().toLocaleString('zh-CN', { hour12: false }),
      ...this.counters,
      cacheSize: this.cache.size,
      last: { ...this.last }
    };
  }

  // ── 第一步：同步判定"要不要为这条消息联网"（纯字符串，不阻塞）────────────
  /**
   * @returns {{query:string, lenient:boolean}|null} null = 直接放行，连 HTTP 都不发
   */
  plan(rawText, { lenient = false } = {}) {
    const o = this.opts();
    // groupTrigger='any'：群里没 @ 她也认（**且不要求触发词**）。
    // groupTrigger='at'：没 @ 她就必须带触发词。
    const requireIntent = lenient ? false : o.groupTrigger !== 'any';
    const query = extractQuery(rawText, {
      intentWords: o.intentWords,
      lenient,
      requireIntent,
      minLen: o.minQueryLen
    });
    return query ? { query, lenient } : null;
  }

  // ── 第二步：查库（带缓存 + 去虚词补搜）──────────────────────────────────
  async #search(keyword, timeoutMs) {
    const url = `${YGOCDB_API}?search=${encodeURIComponent(keyword)}`;
    const res = await this.fetch(url, {
      headers: { 'user-agent': UA, accept: 'application/json,text/plain,*/*' },
      signal: AbortSignal.timeout(timeoutMs),
      redirect: 'follow'
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const list = Array.isArray(data?.result) ? data.result : (Array.isArray(data) ? data : []);
    // 卡库偶尔回"空壳记录"（没名称、密码 0）——留着会让一张不存在的卡变成候选
    return list.map(normalizeCard).filter((c) => c.cn_name || (c.id && c.id !== '0'));
  }

  /**
   * 查库 + 去虚词补搜，返回 `{cards, effective, retriedWith}`。
   *
   * ⚠️ 补搜的条件与门槛**必须与 skills/ygo-ruling 完全一致**（那边是 search_card 的
   *    前 20 行）—— 两处判断一旦分叉，就会出现"技能说是这张、插件说是那张"的分裂。
   *    实测这个坑踩过一次：卡库对「真红眼的黑龙」只回 1 条「真红眼黑龙剑」
   *    （该卡**简中名**正是「真红眼的黑龙剑」，用户的原词是它的前缀 → 60 分假阳性），
   *    不做补搜就会把「真红眼黑龙」答成「真红眼黑龙剑」。
   *
   * `effective` = 真正用来打分的词。补搜成功后它变成核心词 —— 否则会按原词打分，
   * 刚补搜到的「真红眼黑龙」又对不上「真红眼的黑龙」，白补。
   */
  async resolve(query, { allowTruncate = false } = {}) {
    const o = this.opts();
    // 缓存键带上 allowTruncate：同一句话在"明确在对她说"（会多做一次截断搜）和
    // "群里路过"（不做）两种场景下的候选集可能不同，混用缓存会让行为随机。
    const key = String(query).toLowerCase() + (allowTruncate ? '|deep' : '');
    const hit = this.cache.get(key);
    if (hit && Date.now() - hit.at < o.cacheTtlMin * 60_000) return hit;

    let cards = await this.#search(query, o.timeoutMs);
    let effective = query;
    let retriedWith = '';
    let truncatedFrom = '';
    let truncatedLoose = false;
    // 结果可疑地少（0 条，或只有 1~2 条且没有完全同名的）时才补搜
    const core = coreKeyword(query);
    const suspicious = !cards.length
      || (cards.length <= 2 && !cards.some((c) => scoreCard(c, query).score >= 100));
    if (suspicious && core && normName(core) !== normName(query)) {
      const again = await this.#search(core, o.timeoutMs);
      // 补搜结果必须**确实更准**才采用：有完全同名的卡，或原本一条都没有、
      // 而补搜至少有一条沾边的。卡库对乱码/不存在的词也会硬吐一张卡，
      // 不设这个门槛就会把"没这张卡"答成一张完全无关的卡。
      const usable = again.some((c) => scoreCard(c, core).score >= 100)
        || (!cards.length && again.some((c) => scoreCard(c, core).score > 0));
      if (usable) {
        cards = again;
        effective = core;
        retriedWith = core;
        this.log('原词「%s」匹配不佳，已按核心词「%s」补搜', query, core);
      }
    }

    // ── 前缀截断补搜：用户把最后一个字说岔了 ─────────────────────────────
    // 只在"还是太薄"（没有一条够 60 分）且调用方允许时做（allowTruncate = 明确在对她说：
    // 私聊 / @ 她 / 带触发词）。群里路过的消息不做这一步，避免闲聊被追问。
    // 结果**不参与打分**（原词对不上它们本来就够不着），只作"你要的是哪张？"的选项。
    // 见 decide 的 reason='truncated' 分支：默认**只提问、绝不笃定**；唯一例外是搜索词
    // ≥3 字且只剩 1 张 → 那时直接把卡面答出去（一个候选时问"哪一张"没有意义）。
    const thin = !cards.length
      || (cards.length <= 2 && !cards.some((c) => scoreCard(c, effective).score >= 60));
    if (allowTruncate && thin) {
      for (const form of truncatedForms(query)) {
        if (normName(form) === normName(effective)) continue;
        // 只截 1 个字时允许剩下 2 字（「阁楼妖」→「阁楼」）；截掉 2 个字后只剩 2 字
        // 就太容易是常用词巧合了 —— 实测私聊「明天有空吗」→「明天」→【骸骨天使】，
        // 这种全当没搜到（连多余的那次 HTTP 都省掉）。
        if (normName(form).length < 3 && normName(query).length - normName(form).length > 1) continue;
        let again = [];
        try {
          again = await this.#search(form, o.timeoutMs);
        } catch { break; }   // 补搜失败不影响主流程（当作没搜过）
        const strict = again.filter((c) => scoreCard(c, form).score >= 60);
        // 严格门槛过不了时，看能不能按"卡库只回这一张"认下来（四道闸见 looseMatch）。
        const loose = (!strict.length && again.length === 1 && looseMatch(again[0], form)) ? again : [];
        if (!strict.length && !loose.length) continue;
        if (loose.length) {
          // 卡库对这个词只认这一张 —— 候选集就换成它（原本那些对原词也是 0 分，没信息量）
          cards = [loose[0]];
          truncatedLoose = true;
        } else {
          const seen = new Set(cards.map((c) => String(c.id || c.cn_name)));
          for (const c of strict) {
            const id = String(c.id || c.cn_name);
            if (seen.has(id)) continue;
            seen.add(id);
            cards = cards.concat([c]);
          }
          truncatedLoose = false;
        }
        truncatedFrom = form;
        if (loose.length) {
          this.log('原词「%s」查不到同名卡；卡库对「%s」只回【%s】这一张，按它答', query, form, loose[0].cn_name || '?');
        } else {
          this.log('原词「%s」查不到同名卡，已按「%s」再搜一次', query, form);
        }
        break;
      }
    }

    if (this.cache.size >= CACHE_MAX) {
      // 简单 LRU：删掉最早插进去的那条（Map 保序）
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) this.cache.delete(oldest);
    }
    const entry = { at: Date.now(), cards, effective, retriedWith, truncatedFrom, truncatedLoose };
    this.cache.set(key, entry);
    return entry;
  }

  // ── 第三步：由"卡库返回了什么"决定怎么答 ─────────────────────────────────
  /**
   * @param {string} query     用户原话去噪后的词（用来展示"你说的 → 实际是这张"）
   * @param {object} resolved  resolve() 的返回
   * @returns {{kind:'card', card, query, exact:boolean, inferred?:string}
   *          |{kind:'list', items, query, total}
   *          |null}   null = 没问清楚，放行给模型
   *          `inferred` 非空 = 这张是补搜（去掉尾字）找出来的，回复末尾要注明按哪个词找的。
   */
  decide(query, resolved) {
    const o = this.opts();
    const cards = resolved?.cards || [];
    // 用 effective 打分（可能是补搜后的核心词）
    const effective = resolved?.effective || query;
    const scored = cards
      .map((card) => ({ card, ...scoreCard(card, effective) }))
      // 60 分 = 候选名包含查询词。**这条下限不能松**：卡库对任何乱串都会吐一条
      // 沾边的记录，只有 20 分（查询词包含候选名）那种更弱的关系一律不算命中，
      // 否则"我刚抽到羽毛扫开心死了"也会被答成某张卡。
      .filter((x) => x.score >= 60)
      // 同名的重复记录（不同版本/异画）只留一条
      .filter((x, i, arr) => arr.findIndex((y) => normName(y.card.cn_name) === normName(x.card.cn_name)) === i)
      // 同分排序：整词命中 > 主名命中 > 卡库顺序（见 scoreCard）。
      // 实测纠的坑：查「霍普」时「剑斗兽 重斗」（简中名「剑斗兽 霍普洛姆斯」，60 分）
      // 本来压着「No.39 希望皇 霍普」—— 两个都 60 分，只能靠"霍普是不是独立一个词"分开。
      .sort((a, b) => b.score - a.score
        || (b.exactWord ? 1 : 0) - (a.exactWord ? 1 : 0)
        || (b.onPrimary ? 1 : 0) - (a.onPrimary ? 1 : 0));
    if (!scored.length) {
      // ── ① 截断补搜的结果：问"你要的是哪一张" ────────────────────────────
      // 走到这里说明原词连一条 60 分都没有；truncatedFrom 非空表示我们（只在明确
      // 在对她说时）已经用去掉尾字的词搜过一次，且搜到了东西。那些候选**对原词是不
      // 够分的**（够分就不会进这个分支），所以只能当选项列出来问，绝不能挑一张当成
      // "你说的是这张"。现实收益：实测「阁楼妖」本来要模型花 1 分 44 秒去问同一句话，
      // 现在 1 秒内把【阁楼上的妖怪】和【莫忘阁楼怪】一起摆出来让用户指。
      if (resolved?.truncatedFrom) {
        const form = resolved.truncatedFrom;
        const loose = !!resolved.truncatedLoose;
        const items = cards
          // 宽松命中（卡库只回这一张）在原词上必然是 0 分，所以不能拿原词打分 ——
          // 它的"可信度"来自卡库的唯一性判断，这里直接给定分。
          .map((card) => (loose ? { card, score: 40, alias: '', onPrimary: false, exactWord: false } : { card, ...scoreCard(card, form) }))
          .filter((x) => loose || x.score >= 60)
          .filter((x, i, arr) => arr.findIndex((y) => normName(y.card.cn_name) === normName(x.card.cn_name)) === i)
          .sort((a, b) => b.score - a.score
            || (b.exactWord ? 1 : 0) - (a.exactWord ? 1 : 0)
            || (b.onPrimary ? 1 : 0) - (a.onPrimary ? 1 : 0))
          .slice(0, o.maxCandidates);
        if (items.length) {
          // ── 只剩一张、且搜索词够长（≥3 字）→ 直接给卡面（含效果）────────────
          // 问"你要的是哪一张"在一个候选时毫无意义，还会把用户真正要的效果藏起来
          // （2026-10-06「查卡 莫忘阁楼妖」「查卡 冥铭途阁楼妖」两次事故都是这个）。
          // ⚠️ 两字的搜索词不给：常用词撞卡名的巧合太多（实测「明天有空」→ 截到
          //    「明天」→【骸骨天使】），那种继续用提问清单，交给用户自己认。
          if (o.answerOnSingleTruncate && items.length === 1 && normName(form).length >= 3) {
            return { kind: 'card', card: items[0].card, query, exact: false, inferred: form, loose };
          }
          return { kind: 'list', items, query, total: items.length, reason: 'truncated', searchedAs: form };
        }
      }

      // ── ② 弱匹配兜底：跳字缩写 ──────────────────────────────────────────
      // 一条都够不上 60 分时**通常**应该放行给模型（这条下限不能松，见上面注释）。
      // 唯一例外是"用户把卡名中间的字跳掉了"：卡库按这个词已经把候选收敛到很少
      // 几张（≤2），只是连续子串关系对不上（「阁楼妖」对【阁楼上的妖怪】= 0 分）。
      // 这时候问一句比闭嘴划算 —— 模型要几十秒，而它做的也是同一件事
      // （实测它回的就是"你说的是这张吗？"）。
      // ⚠️ 只返回 kind='list'（提问式），**绝不返回 kind='card'** ——
      //    弱匹配没有笃定的资格，猜错一张等于整题答错。
      if (o.askOnWeakMatch && cards.length <= 2) {
        const weak = cards
          .map((card) => ({ card, hit: weakMatch(card, effective) }))
          .filter((x) => x.hit)
          .map((x) => ({ card: x.card, score: 40, alias: x.hit.alias, onPrimary: false, exactWord: false }));
        if (weak.length) return { kind: 'list', items: weak, query, total: weak.length, reason: 'weak' };
      }
      return null;
    }

    const exact = scored.filter((x) => x.score === 100);
    if (exact.length >= 1) {
      return { kind: 'card', card: exact[0].card, query, exact: true };
    }
    if (o.pickMode === 'auto' && scored.length <= o.autoPickMax) {
      return { kind: 'card', card: scored[0].card, query, exact: false };
    }
    return {
      kind: 'list',
      items: scored.slice(0, o.maxCandidates),
      query,
      total: scored.length
    };
  }

  // ── 第四步：查证并组装要发出去的文本（不发送，发送在 index.js）──────────
  /**
   * @returns {{text:string, kind:'card'|'list', query:string, imageUrl:string}|null}
   *          null = 放行给模型 / 冷却中 / 出错；imageUrl 为空串表示不发图
   */
  async compose(chatKey, rawText, { lenient = false, allowTruncate = null } = {}) {
    const plan = this.plan(rawText, { lenient });
    if (!plan) {
      this.counters.noAnswer += 1;
      return null;
    }
    // 截断补搜（去掉尾字再搜一次）只在"明确在对她说"时做：私聊 / @ 她 / 带触发词。
    // 群里路过的消息不做 —— 否则闲聊会被追问"你要的是哪张"。
    const deep = allowTruncate === null ? lenient : !!allowTruncate;
    const o = this.opts();
    const last = this.lastAt.get(chatKey) || 0;
    if (Date.now() - last < o.cooldownMs) {
      this.log('冷却中，放行给模型：%s', plan.query);
      this.counters.passthrough += 1;
      return null;
    }

    let resolved;
    try {
      resolved = await this.resolve(plan.query, { allowTruncate: deep });
    } catch (error) {
      this.counters.errors += 1;
      this.warn('查库失败（放行给模型）：%s', error?.message ?? error);
      return null;
    }

    const decision = this.decide(plan.query, resolved);
    if (!decision) {
      this.counters.passthrough += 1;
      this.log('「%s」对不上卡库，放行给模型', plan.query);
      return null;
    }

    const text = decision.kind === 'card'
      ? formatCardAnswer(decision, o)
      : formatCandidateList(decision, o);
    // 配图：确定的卡就发它自己；候选清单发**最可能那张**的图（配合"你说的是这张吗？"）。
    // 地址只在插件内部用、绝不写进 text —— 文件名就是卡片密码（见 cardImageUrl 注释）。
    const imageCard = decision.kind === 'card' ? decision.card : (decision.items?.[0]?.card ?? null);
    const imageUrl = o.sendImage ? cardImageUrl(imageCard?.id) : '';
    this.counters[decision.kind === 'card' ? 'answered' : 'listed'] += 1;
    // 单列一个计数：这两种是"没对上但也没放行"，出了误判要能一眼看出占比
    if (decision.reason === 'weak' || decision.reason === 'truncated') this.counters.asked += 1;
    this.lastAt.set(chatKey, Date.now());
    this.last = { at: Date.now(), chatKey, query: plan.query, result: decision.kind, reason: decision.reason || '', chars: text.length };
    return { text, kind: decision.kind, query: plan.query, imageUrl: imageUrl || '' };
  }
}

// ── 组文本（发给 QQ，纯文本 —— 发送管道会跑 mdToPlain，别写 markdown）────────

/** 卡片插图的图床，文件名就是卡片密码（实测 2026-10-05：老卡/新卡共 4 张全部 200、image/jpeg）。 */
const CARD_IMAGE_BASE = 'https://cdn.233.momobako.com/ygopro/pics/';

/**
 * 卡片密码 → 插图直链。
 * ⚠️ 这个地址**只用来发图**，绝不写进给用户看的文本里 —— 文件名是卡片密码，
 *    念出来就是"报了一串没意义的数字"（与 skills/ygo-ruling 同一约定）。
 */
export function cardImageUrl(id) {
  const n = String(id ?? '').replace(/\D/g, '');
  return n ? `${CARD_IMAGE_BASE}${n}.jpg` : '';
}

function aliasLine(card) {
  const parts = [
    card.jp_name && `日文：${card.jp_name}`,
    card.en_name && `英文：${card.en_name}`,
    card.sc_name && card.sc_name !== card.cn_name && `简中：${card.sc_name}`,
    card.md_name && card.md_name !== card.cn_name && `MD：${card.md_name}`,
    card.nwbbs_n && card.nwbbs_n !== card.cn_name && `民翻：${card.nwbbs_n}`,
    card.cnocg_n && card.cnocg_n !== card.cn_name && `CNOCG：${card.cnocg_n}`
  ].filter(Boolean);
  return parts.length ? `别名：${parts.join(' / ')}` : '';
}

/** 卡面：名称/类型/（灵摆）/效果。**不含密码、cid**（内部编号，模型那条链路上也早就剥掉了）。 */
export function formatCardAnswer({ card, query, inferred }, o = {}) {
  const name = card.cn_name || '（无名）';
  const type = compactTypes(card.types);
  const said = String(query || '').trim();
  // 用户说的名字与卡名不一致时点明对应关系（「黑魔导」→【黑魔术师】），
  // 否则用户会以为查错了 —— 这是"按别名命中"的必然结果。
  const head = (!said || normName(said) === normName(name))
    ? (type ? `【${name}】${type}` : `【${name}】`)
    : (type ? `「${said}」→【${name}】${type}` : `「${said}」→【${name}】`);

  const lines = [head];
  if (o.showAlias) {
    const a = aliasLine(card);
    if (a) lines.push(a);
  }
  if (card.pdesc) lines.push(`灵摆效果：${card.pdesc}`);
  lines.push(card.desc || '（这张卡没有效果文本）');
  // 名字是"截断补搜"推出来的（用户末字说岔了）→ 末尾点明按哪个词找的。
  // 放在效果**后面**：他要的是效果，先给；这句只是免得他以为库里有这个卡名。
  if (inferred) {
    lines.push(`（卡库里没有正好叫「${said}」的卡，这张是按「${inferred}」找的；不是它的话给我完整的卡名）`);
  }
  return lines.join('\n');
}

function formatCandidateList({ items, query, total, reason, searchedAs }, o = {}) {
  // 第一行就明确问用户（配合下面那一张插图）：「是不是这张？不是的话请给完整卡名」。
  // 用户要的就是这句话 —— 猜错一张等于整题答错，问一句成本最低。
  // 两种"不确定"的措辞都要比普通候选清单再退一步：
  //   · truncated（按去掉尾字的词搜到的）→ 连"对得上"都不能说，只能请用户指认；
  //   · weak（跳字缩写，卡库已收敛到 1~2 张）→ 说"最接近的是这张"，并要完整卡名。
  const head = reason === 'truncated'
    ? `「${query}」没查到同名的卡，按「${searchedAs || query}」找到这几张 —— 你要的是哪一张？`
    : reason === 'weak'
      ? `「${query}」没找到同名的卡，最接近的是下面这张。你说的是它吗？不是的话请给我完整的卡名：`
      : `「${query}」对得上 ${total} 张，你说的是这张吗？不是的话请给我完整的卡名：`;
  const lines = [head];
  items.forEach((x, i) => {
    const type = compactTypes(x.card.types);
    lines.push(`${i + 1}. ${x.card.cn_name || '（无名）'}${type ? ` ｜ ${type}` : ''}`);
  });
  if (total > items.length) lines.push(`（只列了前 ${items.length} 张）`);
  return lines.join('\n');
}

export const internals = { DEFAULTS, POLITE_WORDS, RULING_RE, coreKeyword, weakMatch, isSubsequence, looseMatch, commonRun, formatCardAnswer, formatCandidateList };
