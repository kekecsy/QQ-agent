// 英雄联盟（LoL）电竞赛事查询技能（LLM 型）—— 查最近赛程、近期赛果。
//
// 为什么是 skill 而不是 plugin：什么时候该查、查哪几天、查哪支队，只能由模型
// 理解用户的话来判断，没有"满足条件必然执行"的时机，故走 registerTool + prompt 引导。
// 零第三方依赖：原生 fetch + JSON 解析。
//
// ── 数据源实测结论（2026-10 在本机实测，勿凭记忆改动）──────────────────────
//   【主源】lolesports 官方公开接口（无需用户 API Key，用的是 lolesports.com 网页端
//           公开的 x-api-key）：
//             https://esports-api.lolesports.com/persisted/gw/getSchedule?hl=zh-CN
//             https://esports-api.lolesports.com/persisted/gw/getEventDetails?hl=zh-CN&id=<matchId>
//           实测：HTTP 200，80 条/页，带 pages.older / pages.newer 游标分页。
//           返回片段：{"data":{"schedule":{"pages":{...},"events":[{"startTime":
//           "2026-10-03T20:00:00Z","state":"completed","blockName":"淘汰赛","league":
//           {"name":"LCS","slug":"lcs"},"match":{"id":"...","strategy":{"count":5},
//           "teams":[{"code":"LYON","result":{"gameWins":3}},...]}}]}}}
//
//   【小局详情源】Riot 官方 livestats（无需 Key）：
//             https://feed.lolesports.com/livestats/v1/window/<gameId>
//             https://feed.lolesports.com/livestats/v1/window/<gameId>?startingTime=<ISO>
//           实测：HTTP 200。不带 startingTime 返回开局前若干帧（首帧时间=实际开局时间）；
//           startingTime 必须是"整分钟"格式（秒位为 00，如 2026-07-24T10:50:00Z），
//           带秒或毫秒会直接 400；传早于开局的时间返回 204；传远大于结束时间仍会返回
//           最后 10 帧，其中最后一帧 gameState === "finished"，含本局用时与双方总击杀。
//           ⚠️ 但"晚于结束"成立的前提是它已发生在**当前时刻之前**：startingTime 在
//           当前时刻之后（未来）会返回空帧。刚结束的局拿 start+90min 当探测点必踩空
//           —— QA 拨钟注入复现过：G3 整行消失 + 误报"与官方大比分不一致"，约 19 分钟
//           后"自愈"。所以探测点必须 clamp 到 now-60s（永远在过去），全失败再用
//           now-60s 兜一次；渲染层也绝不能丢局行（见 fetchGameEnd/renderGames）。
//           结束帧片段：{"rfc460Timestamp":"2026-07-24T09:52:09.825Z","gameState":"finished",
//           "blueTeam":{"totalGold":67107,"inhibitors":2,"towers":9,"totalKills":22},
//           "redTeam":{"totalGold":62157,"inhibitors":0,"towers":4,"totalKills":13}}
//
//   【备用源 2】Liquipedia 全站比赛聚合页（实测可用）：
//             https://liquipedia.net/leagueoflegends/api.php?action=parse
//               &page=Liquipedia:Matches&prop=text&formatversion=2
//           实测：HTTP 200，单请求返回全站 upcoming + recent 各 50 场的渲染 HTML
//           （约 430KB），每场一个 <div class="match-info"> 块：
//             · <span class="timer-object" data-timestamp="1791057600"
//               data-finished="finished"> —— data-timestamp 是 Unix 秒（UTC，无需再
//               解析时区缩写），data-finished 标已结束；
//             · 左右队伍各一个 <div class="match-info-header-opponent ...">，缩写队名
//               在 <span class="name"><a title="全称">缩写</a></span>；
//             · 比分按 左:右 排在 match-info-header-scoreholder-score 里；
//             · 赛事在 match-info-tournament 链接的 title 里，是 wiki 页面路径
//               （如 "LCS/2026/Summer/Playoffs#Playoffs"），首段（跳过 20xx 年份段）
//               就是赛事名，"LCK/Academy/2026/..." 要读成 "LCK Academy" 免得混进 LCK。
//           ToU 限 2 请求/秒，且必须用自报身份的 UA（LIQUID_UA）——所以只在官方源
//           失败/为空时调 1 次。
//
//   【备用源 3】Leaguepedia Cargo API（https://lol.fandom.com/api.php?action=cargoquery...）
//           实测结论：**限流极频繁，基本不可用**——它不是完全不可用，冷启动偶尔能成功
//           一次并返回真实数据，但只要连着发就会被限：返回 HTTP 200 而 body 是
//           {"error":{"code":"ratelimited","info":"You've exceeded your rate limit..."}}，
//           且间隔 25s / 150s / 数分钟后重试同样拿不到（换 UA、换 formatversion=2、
//           缩小 limit 均无效）；Special:CargoExport 端点则被 Cloudflare 挡回 403。
//           保留在代码里作最后一级兜底（它响应很快、失败不拖时间），但别指望它。
//
// ── 第三方数据使用口径（用户 2026-10-04 定，覆盖此前任何"交叉核对"设想）────────
//   · Liquipedia / Leaguepedia 等第三方站点**只**允许当官方 Riot 接口失败或缺失字段
//     时的**补充来源**，输出里必须明确标注"非官方补充来源"；
//   · 不引入任何第三方比对：不打分、不标注"与官方一致/不一致"、不加第三方交叉核对类设置；
//   · 绝不声称数据经过第三方验证或与官方比对一致——第三方数据仅供参考，以官方渠道发布为准。
//
// ── 时间窗语义（2026-10-04 用户报"今天就有的比赛没搜到"，实测修复）──────────
//   · **赛程工具绝不能按 state 过滤掉已结束的比赛**。用户问"今天有什么比赛"时，
//     当天凌晨/上午打完的比赛必须照样列出（✅ 标注 + 带官方比分）。旧实现写了
//     `.filter(e => e.state !== 'completed')`，实测在 2026-10-04 17:46 这一天把
//     当天 5 场里的 4 场干掉了——连一线赛事 LCS LYON 3:1 C9 都消失了。
//   · **时间窗必须是"含今天在内的 N 个自然日"**，起点用目标时区的当天 00:00，
//     不能用 `now - 6h ~ now + N*24h` 这种相对窗口：当天 17:46 查询时，
//     相对窗口下限是 11:46，当天 00:00 和 04:00 的两场必然掉出窗外。
//   · 时区换算不能用 Date.UTC 硬算（会落到本机时区），必须用 Intl 取目标时区的
//     年月日再换算，并在夏令时切换日做二次校正（见 startOfDayInTz）。
//   · 远程日期存在大量 TBD vs TBD 占位条目，按时间排序会挤占 maxResults 名额，
//     必须让"有明确对阵"的排前面、TBD 沉底后再截断。
//   · 任何被过滤掉的条目都要在返回文本里说明数量和赛事名，**不许静默丢失**。
//
// ── 功能 ────────────────────────────────────────────────────────────────
//   · 战队筛选：不填就全报；填了（如 京东、滔搏、T1、G2）就只报这些战队的比赛，
//     中文名 ↔ 英文缩写双向匹配。
//   · 赛事过滤：默认**不**按赛事等级过滤，各赛事都报；用户点名赛事（leagues 参数，
//     如 LPL、世界赛、德杯）就只报该赛事；设置里另有「只看一线赛事」开关（默认关）。
//     点名战队时一线开关自动失效（非一线也报）。**被过滤掉的数量会如实告知。**
//   · 赛程：从「今天 00:00」起算 N 个自然日，含今天已结束（✅+比分）、进行中
//     （▶️+实时局分）、未开始三类，一场不漏。
//   · 赛果：已结束比赛的大比分；部分比赛展开每小局用时与双方总击杀。
//     小局胜者**仅**取 livestats 终局数据的逐局判定，若合计与官方 gameWins 不符
//     则如实告警并提示"请以官方大比分为准"——**绝不按优势度重新分配去凑数**
//     （那等于编造每小局的赢家）。判不出的小局显示「胜方未判定」。

let cfg = () => ({});
let httpFetch = null;
let logger = null;

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';

const API_BASE = 'https://esports-api.lolesports.com/persisted/gw';
// lolesports.com 网页端公开的 API Key（随前端代码发布，非用户私有凭证，无需用户申请）
const ESPORTS_KEY = '0TvQnueqKa5mxJntVWt0w4LpLfEkrV1Ta8rQBb9Z';
const FEED_BASE = 'https://feed.lolesports.com/livestats/v1';
const LEAGUEPEDIA_API = 'https://lol.fandom.com/api.php';
const LIQUID_API = 'https://liquipedia.net/leagueoflegends/api.php';
// Liquipedia 使用条款要求自报身份的 UA，且限 2 请求/秒（本技能只在官方源失败时打 1 次）
const LIQUID_UA = 'QQAgent-LolMatch/1.0 (local user skill for LoL schedule/results; contact: local user)';

const ESPORTS_HEADERS = {
  'User-Agent': UA,
  'Accept': 'application/json',
  'x-api-key': ESPORTS_KEY
};

// ── 战队中英文对照：别名 → 用于匹配的英文关键词（队名缩写 or 全称片段）─────────
const TEAM_ALIASES = {
  // LPL
  '京东': ['jdg'], 'jdg': ['jdg'], '京东电竞': ['jdg'],
  '滔搏': ['tes'], '滔博': ['tes'], '涛搏': ['tes'], 'tes': ['tes', 'top esports'], 'top esports': ['tes', 'top esports'],
  '哔哩哔哩': ['blg'], 'b站': ['blg'], 'bilibili': ['blg'], 'blg': ['blg'],
  '微博': ['wbg'], 'weibo': ['wbg'], 'wbg': ['wbg'],
  'al': ['al'], 'anyones legend': ['al'], "anyone's legend": ['al'],
  'lng': ['lng'], '苏州lng': ['lng'],
  'nip': ['nip'],
  'fpx': ['fpx'], '小凤凰': ['fpx'],
  'edg': ['edg'], '爱德华': ['edg'], '厂长队': ['edg'],
  'rng': ['rng'], '皇族': ['rng'],
  'we': ['we'], '西安we': ['we'], 'team we': ['we'],
  'ig': ['ig'], 'ig电子竞技': ['ig'], 'invictus gaming': ['ig'], '王校长队': ['ig'],
  'omg': ['omg'],
  'tt': ['tt'], 'thunder talk': ['tt'],
  'up': ['up'], 'ultra prime': ['up'],
  'lgd': ['lgd'], '老干爹': ['lgd'],
  'lgd大鹅': ['lgd'],
  // LCK
  't1': ['t1'], '李哥的队': ['t1'], 'skt': ['t1'], 'skt t1': ['t1'],
  'gen': ['gen'], 'gen.g': ['gen'], 'geng': ['gen'], '三星': ['gen'], 'gen.g esports': ['gen'],
  'hle': ['hle'], 'hanwha life': ['hle'], '韩华': ['hle'],
  'dk': ['dk'], 'damwon': ['dk'], 'dwg': ['dk'], '大乌龟': ['dk'], 'dplus kia': ['dk'],
  'kt': ['kt'], 'kt rolster': ['kt'],
  'bro': ['bro'], 'b ro': ['bro'], 'fredit': ['bro'], 'brion': ['bro'],
  'drx': ['drx'], 'krx': ['krx'], 'kwangdong': ['krx'],
  'ns': ['ns'], 'nongshim': ['ns'], 'bfx': ['bfx'], 'dnf': ['dnf'], 'dn freecs': ['dnf'],
  // LEC / EMEA
  'g2': ['g2'], 'g2 esports': ['g2'], '银河战舰': ['g2'],
  'fnc': ['fnc'], 'fnatic': ['fnc'],
  'mad': ['mad'], 'mad lions': ['mad'], 'mad lions koia': ['mad'],
  'kc': ['kc'], 'karmine': ['kc'], 'karmine corp': ['kc'],
  'vit': ['vit'], 'vitality': ['vit'], '小蜜蜂': ['vit'],
  'th': ['th'], 'heretics': ['th'], 'team heretics': ['th'],
  'bds': ['bds'], 'rge': ['rge'], 'rogue': ['rge'],
  'sk': ['sk'], 'sk gaming': ['sk'], 'navi': ['navi'], 'natus vincere': ['navi'],
  'shft': ['shft'], 'giants': ['giants'],
  // LTA（原 LCS / 美洲）
  'tl': ['tl'], 'liquid': ['tl'], 'team liquid': ['tl'], '液体': ['tl'],
  'fly': ['fly'], 'flyquest': ['fly'],
  'c9': ['c9'], 'cloud9': ['c9'], '云九': ['c9'],
  '100t': ['100t'], '100 thieves': ['100t'],
  'lyon': ['lyon'], 'dig': ['dig'], 'dignitas': ['dig'], 'sr': ['sr'], 'shopify rebellion': ['sr'],
  'tlaw': ['tlaw'], 'team law': ['tlaw'],
  // LCP / 亚太
  'psg': ['psg'], 'psg talon': ['psg'], 'tsw': ['tsw'], 'talon': ['psg', 'tsw'],
  'gam': ['gam'], 'dfm': ['dfm'], 'detonation': ['dfm'], 'cfo': ['cfo'],
  'mvk': ['mvk'], 'shg': ['shg'], 'gz': ['gz'], 'hk': ['hk']
};

// 判定"一线赛事"时要排除的次级/青训赛事关键词（避免 LCK 把 LCK Challengers 也算进来）
const TOP_EXCLUDE = [
  'challengers', 'promotion', 'promo', 'academy', 'amateur', 'relegation',
  'qualifying', 'clash', 'circuito', 'nacl', 'open qualifiers'
];

// ── 通用小工具 ───────────────────────────────────────────────────────────
function clamp(n, lo, hi, fallback) {
  const v = Number(n);
  if (!isFinite(v)) return fallback;
  return Math.min(hi, Math.max(lo, v));
}

/** 转成 livestats 能接受的"整分钟"ISO 时间（秒位必须是 00，否则接口返回 400）。 */
function minIso(ms) {
  return new Date(ms).toISOString().slice(0, 17) + '00Z';
}

const WEEKDAY_MAP = {
  周一: '周一', 周二: '周二', 周三: '周三', 周四: '周四', 周五: '周五', 周六: '周六', 周日: '周日',
  星期一: '周一', 星期二: '周二', 星期三: '周三', 星期四: '周四', 星期五: '周五', 星期六: '周六', 星期日: '周日'
};

/** 毫秒时间戳 → 用户时区的「M月D日 周X HH:MM」 */
function fmtTime(ms, tz) {
  const d = new Date(ms);
  try {
    const parts = new Intl.DateTimeFormat('zh-CN', {
      timeZone: tz, month: 'numeric', day: 'numeric',
      weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false
    }).formatToParts(d);
    const p = {};
    for (const x of parts) p[x.type] = x.value;
    const w = WEEKDAY_MAP[p.weekday] || p.weekday;
    return `${Number(p.month)}月${Number(p.day)}日 ${w} ${p.hour}:${p.minute}`;
  } catch {
    return d.toISOString().replace('T', ' ').slice(0, 16);
  }
}

/** 毫秒 → 「MM:SS」（LoL 单局用时） */
function fmtDuration(ms) {
  if (!isFinite(ms) || ms < 0) return '未知';
  const total = Math.round(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

/**
 * 目标时区在 ms 时刻的 UTC 偏移（毫秒）。
 * 用 Intl 逐字段取值再拼回 UTC，避免依赖本机时区；hour 取模 24 是因为部分环境下
 * hour12:false 的午夜会返回 "24"。
 */
function tzOffsetMs(ms, tz) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit'
  }).formatToParts(new Date(ms));
  const p = {};
  for (const x of parts) p[x.type] = x.value;
  const asIfUtc = Date.UTC(
    Number(p.year), Number(p.month) - 1, Number(p.day),
    Number(p.hour) % 24, Number(p.minute), Number(p.second)
  );
  return asIfUtc - Math.floor(ms / 1000) * 1000;
}

/**
 * ms 所在「自然日」在该时区的 00:00 对应的 UTC 毫秒。
 * 夏令时切换日做二次校正：先用初次偏移算出午夜，再用午夜自身的偏移复核。
 *
 * 实测踩坑：这里**不能**用 now - 6h 之类的相对窗口当"今天起点"，也不能用
 * Date.UTC 硬算（会落到本机时区），否则北京时间下午查当天赛程时，当天凌晨/上午
 * 已结束的比赛会掉出窗口（见文件头"赛程不能按 state 删已完成比赛"那条实测结论）。
 */
function startOfDayInTz(ms, tz) {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit'
    }).formatToParts(new Date(ms));
    const p = {};
    for (const x of parts) p[x.type] = x.value;
    const utcGuess = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), 0, 0, 0, 0);
    let midnight = utcGuess - tzOffsetMs(utcGuess, tz);
    // 夏令时边界：用 midnight 自身的偏移再算一次，不一致则以它为准
    const off2 = tzOffsetMs(midnight, tz);
    if (off2 !== tzOffsetMs(utcGuess, tz)) midnight = utcGuess - off2;
    return midnight;
  } catch {
    return Math.floor(ms / 86400000) * 86400000;
  }
}

/** 该场是否为「对阵待定」（数据源常见 TBD vs TBD / 队伍数组为空） */
function isTbdRow(m) {
  const norm = (s) => String(s || '').trim().toUpperCase();
  const a = norm(m?.code1);
  const b = norm(m?.code2);
  return !a || !b || a === 'TBD' || b === 'TBD' || a === '待定' || b === '待定';
}

/**
 * 渲染对阵。已结束的带官方比分，进行中的带实时局分（0:0 时不显示，避免误导），
 * 未开始 / 对阵待定的保持 "A vs B"。
 */
function renderMatchup(m) {
  const tbd = isTbdRow(m);
  const s1 = m.score1;
  const s2 = m.score2;
  const hasScore = s1 != null && s2 != null;
  if (tbd) return `${m.code1} vs ${m.code2}（对阵待定）`;
  if (m.state === 'completed' && hasScore) return `${m.code1} ${s1}:${s2} ${m.code2}`;
  if (m.state === 'inProgress' && hasScore && (s1 !== 0 || s2 !== 0)) return `${m.code1} ${s1}:${s2} ${m.code2}`;
  return `${m.code1} vs ${m.code2}`;
}

/** 赛程行的状态前缀：已结束 ✅ / 进行中 ▶️ / 未开始 无前缀 */
function scheduleStatePrefix(state) {
  if (state === 'completed') return '✅ ';
  if (state === 'inProgress') return '▶️ ';
  return '';
}

/** 逗号/顿号/分号/竖线/空白分隔的普通列表 */
function readList(raw) {
  return String(raw || '')
    .split(/[,，、;；|\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * 战队筛选词列表。先按逗号类符号切，再按空格切；
 * 但如果整个片段是已知别名（如 "Top Esports"），就整体保留，不拆开。
 */
function readTeamList(raw) {
  const parts = String(raw || '')
    .split(/[,，、;；|]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  const out = [];
  for (const p of parts) {
    const low = p.toLowerCase();
    if (TEAM_ALIASES[low] || TEAM_ALIASES[p]) { out.push(p); continue; }
    if (/\s/.test(p)) { out.push(...p.split(/\s+/).filter(Boolean)); continue; }
    out.push(p);
  }
  return out;
}

/**
 * 某个 token 是否命中一支战队。
 *
 * 实测踩过的坑（勿改回宽松匹配）：
 *   · 早先用队名子串匹配，搜「滔搏」=tes 会命中 "Fri**tes** Esports Club"、
 *     "TLN Pira**tes**"；搜「T1」=t1 会命中 "T1 Esports Academy"（T1A，青训队，
 *     和 T1 是两支不同的队）。所以：长度 ≤3 的缩写只允许**完全等于**战队缩写 code；
 *     只有 4 字符及以上的关键词才允许做队名子串匹配。
 */
function teamMatchesToken(team, token) {
  const code = String(team?.code || '').toLowerCase();
  const name = String(team?.name || '').toLowerCase();
  const t = String(token || '').toLowerCase().trim();
  if (!t || (!code && !name)) return false;
  if (code === t) return true;
  if (!code) {
    if (name === t) return true;
    const esc = t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(^|[^a-z0-9])${esc}([^a-z0-9]|$)`).test(name);
  }
  if (t.length <= 3) return false;
  if (code.includes(t)) return true;
  return name.includes(t);
}

/** 一支战队是否命中任一筛选词 */
function matchTeam(team, filters) {
  if (!filters.length) return true;
  for (const f of filters) {
    const key = String(f).trim().toLowerCase();
    if (!key) continue;
    const tokens = TEAM_ALIASES[key] || TEAM_ALIASES[f] || [key];
    for (const tk of tokens) {
      if (teamMatchesToken(team, tk)) return true;
    }
  }
  return false;
}

// ── 赛事别名：用户口径的中文/口语名 → 数据源里的英文名 ─────────────────────────
// 匹配前两边都会做 normKey（小写、去空格/连字符/下划线），所以 'demacia cup'、
// 'Demacia_Cup'、'demacia-cup' 都归一到 'demaciacup'。
// 实测：Riot 数据里德玛西亚杯 name='DCGI'、slug='demacia_cup'，所以 leagues='德杯'
// 要靠别名同时能打中这两个字段；Liquipedia 那边则叫 "Demacia Cup"。
const LEAGUE_ALIASES = {
  '德杯': ['dcgi', 'demacia cup', 'demacia'],
  '德玛西亚杯': ['dcgi', 'demacia cup', 'demacia'],
  'demacia': ['dcgi', 'demacia cup'],
  '世界赛': ['worlds', 'world championship'],
  '全球总决赛': ['worlds', 'world championship'],
  's赛': ['worlds', 'world championship'],
  '季中赛': ['msi', 'mid season invitational'],
  '季中冠军赛': ['msi', 'mid season invitational'],
  'msi': ['msi', 'mid season invitational'],
  'worlds': ['worlds', 'world championship'],
  'lta': ['lta', 'lta north', 'lta south']
};

/** 归一化：小写、去掉空格/连字符/下划线/点，用于赛事名宽松比对 */
function normKey(s) {
  return String(s || '').toLowerCase().replace(/[\s\-_.]+/g, '');
}

/** 一个赛事关键词 → 参与匹配的关键词组（含别名展开，全部 normKey 过） */
function expandLeagueTokens(token) {
  const t = String(token || '').trim();
  if (!t) return [];
  const out = [normKey(t)];
  for (const a of LEAGUE_ALIASES[t.toLowerCase()] || []) out.push(normKey(a));
  return out;
}

/**
 * 某个关键词是否命中一个赛事。name 和 slug 都参与比对。
 * 长度 ≤3 的缩写（lpl/lck/msi）只允许完全等于，避免 'lcs' 误伤 'LCS Promotion'
 * 之外的怪名字；4 字符以上才允许包含式匹配（'worlds' → World Championship
 * 靠别名表兜住，不靠子串）。
 */
function leagueMatchesToken(league, token) {
  const name = normKey(league?.name);
  const slug = normKey(league?.slug);
  if (!name && !slug) return false;
  for (const tk of expandLeagueTokens(token)) {
    if (!tk) continue;
    if (name === tk || slug === tk) return true;
    if (tk.length >= 4 && (name.includes(tk) || slug.includes(tk))) return true;
  }
  return false;
}

/**
 * 赛事是否属于"一线赛事"。同样走别名展开 + normKey，保证 Liquipedia 备用数据的
 * "World Championship / Mid-Season Invitational" 也能被 topEvents 里的
 * 'Worlds'/'MSI' 命中。
 */
function isTopLeague(league, tokens) {
  const normName = normKey(league?.name);
  const normSlug = normKey(league?.slug);
  const hay = `${normName} ${normSlug}`;
  for (const ex of TOP_EXCLUDE) {
    if (hay.includes(ex)) return false;
  }
  for (const t of tokens) {
    for (const tk of expandLeagueTokens(t)) {
      if (!tk) continue;
      if (normName === tk || normSlug === tk) return true;
      if (normName.includes(tk) || normSlug.includes(tk)) return true;
    }
  }
  return false;
}

// ── HTTP ────────────────────────────────────────────────────────────────
/**
 * 带 JSON 解析与瞬时重试的 GET。
 * 重试纪律（2026-10-04 定）：只在**连接层失败**（fetch reject / 超时 / 读响应体失败）
 * 后等 800ms 重试一次；HTTP 4xx/5xx 是服务器明确响应，不算瞬时故障，绝不重试
 * （404 重试纯属白等）。JSON 解析失败也不是网络故障，不重试。
 * 注意：每次尝试独立计时 timeoutMs，单次调用最坏耗时 ≈ 2×timeoutMs + 800ms。
 */
async function fetchJson(url, timeoutMs, headers) {
  const attempt = async () => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await httpFetch(url, {
        signal: ctrl.signal,
        redirect: 'follow',
        headers: { 'User-Agent': UA, 'Accept': 'application/json', ...(headers || {}) }
      });
      // livestats 在"时间早于开局"时返回 204 空响应，视为无数据
      if (res.status === 204) return { error: '无数据（204）' };
      if (!res.ok) return { error: `HTTP ${res.status}` };
      const text = await res.text();
      if (!text) return { error: '空响应' };
      const data = JSON.parse(text);
      return { data };
    } catch (e) {
      if (e instanceof SyntaxError) {
        // 响应到了但不是合法 JSON：这是响应内容问题，不是网络瞬时故障
        return { error: `抓取失败：解析 JSON 失败：${e.message}` };
      }
      const msg = e?.name === 'AbortError' ? `超时（${timeoutMs}ms）` : (e?.message ?? String(e));
      // 走到这里说明 fetch 或读响应体在连接层失败，属于可重试的瞬时故障
      return { error: `抓取失败：${msg}`, transient: true };
    } finally {
      clearTimeout(timer);
    }
  };
  let out = await attempt();
  if (out.transient) {
    if (logger) logger.warn('lol-match: 网络瞬时故障，800ms 后重试一次：%s', url);
    await new Promise((r) => setTimeout(r, 800));
    out = await attempt();
  }
  return out.error ? { error: out.error } : out;
}

/** 有限并发地串行处理数组，避免一次性打太多请求 */
async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let idx = 0;
  const worker = async () => {
    while (idx < items.length) {
      const i = idx++;
      results[i] = await fn(items[i], i);
    }
  };
  const pool = [];
  const n = Math.max(1, Math.min(limit, items.length));
  for (let i = 0; i < n; i++) pool.push(worker());
  await Promise.all(pool);
  return results;
}

// ── 主源：lolesports 赛程分页 ────────────────────────────────────────────
/**
 * 沿游标方向翻页收集赛程事件。
 * @param {'newer'|'older'} direction newer=往未来翻，older=往过去翻
 * @returns {{events: Array}|{error: string}}
 */
async function collectEvents(direction, maxPages, timeoutMs) {
  const out = [];
  const seen = new Set();
  let token = null;
  let firstError = null;
  for (let i = 0; i < maxPages; i++) {
    const url = `${API_BASE}/getSchedule?hl=zh-CN` + (token ? `&pageToken=${encodeURIComponent(token)}` : '');
    const res = await fetchJson(url, timeoutMs, ESPORTS_HEADERS);
    if (res.error) {
      firstError = res.error;
      if (i === 0) return { error: firstError };
      break;
    }
    const events = res.data?.data?.schedule?.events || [];
    for (const e of events) {
      const id = e?.match?.id || `${e?.startTime}|${e?.league?.slug}`;
      if (!id || seen.has(id)) continue;
      seen.add(id);
      out.push(e);
    }
    const pages = res.data?.data?.schedule?.pages || {};
    const next = direction === 'newer' ? pages.newer : pages.older;
    if (!next) break;
    token = next;
  }
  if (!out.length) return { error: firstError || '未取到任何赛程数据' };
  return { events: out };
}

// ── 小局详情：Riot livestats ─────────────────────────────────────────────
/**
 * 取单局的开局时间与终局数据。
 * 关键实测经验：startingTime 必须是整分钟（秒位 00），否则 400。
 * 探测点纪律（2026-10-04 修 G3 时序 bug，QA 拨钟注入复现过勿回退）：
 *   · 刚结束的局，start+90min 还在未来，livestats 对未来 startingTime 返回**空帧**
 *     （不是最后 10 帧！）→ 旧实现拿不到终局帧 → 该局整行消失 → 逐局判定合计缺一局
 *     → 误报"与官方大比分不一致"，约 19 分钟后才"自愈"；
 *   · 所以探测点必须 clamp：probe = min(start+90min, now-60s)，永远落在已发生的时间；
 *   · 4 次探测仍拿不到 finished 帧，再用 now-60s 兜一次（livestats 对"晚于结束且
 *     已发生"的时间返回最后 10 帧，最后一帧就是终局）。
 */
async function fetchGameEnd(gameId, timeoutMs) {
  const first = await fetchJson(`${FEED_BASE}/window/${gameId}`, timeoutMs);
  if (first.error || !first.data?.frames?.length) return null;
  const startMs = Date.parse(first.data.frames[0].rfc460Timestamp);
  if (!isFinite(startMs)) return null;

  let endFrame = null;
  // 探测点必须在过去：clamp 到 now-60s（修 G3 时序 bug 的核心一行）
  let probe = Math.min(startMs + 90 * 60 * 1000, Date.now() - 60000);
  for (let i = 0; i < 4; i++) {
    const res = await fetchJson(`${FEED_BASE}/window/${gameId}?startingTime=${minIso(probe)}`, timeoutMs);
    if (res.error) break;
    const frames = res.data?.frames || [];
    const last = frames.length ? frames[frames.length - 1] : null;
    if (last && Date.parse(last.rfc460Timestamp) > Date.parse(endFrame?.rfc460Timestamp ?? 0)) {
      endFrame = last;
    }
    if (endFrame && endFrame.gameState === 'finished') break;
    // 没探到终局帧：往后跳 30 分钟再探（至少从开局后 5 分钟起），并再次 clamp 到过去
    const base = endFrame ? Date.parse(endFrame.rfc460Timestamp) : probe;
    probe = Math.min(
      Math.max(startMs + 5 * 60 * 1000, base + 30 * 60 * 1000),
      Date.now() - 60000
    );
  }
  // 全失败回退：直接拿"当前时间-60s"，只要它晚于结束时间就会返回最后 10 帧
  if (!endFrame || endFrame.gameState !== 'finished') {
    const res = await fetchJson(`${FEED_BASE}/window/${gameId}?startingTime=${minIso(Date.now() - 60000)}`, timeoutMs);
    if (!res.error) {
      const frames = res.data?.frames || [];
      const last = frames.length ? frames[frames.length - 1] : null;
      if (last && (!endFrame || Date.parse(last.rfc460Timestamp) > Date.parse(endFrame.rfc460Timestamp))) {
        endFrame = last;
      }
    }
  }
  if (!endFrame) return null;

  const b = endFrame.blueTeam || {};
  const r = endFrame.redTeam || {};
  return {
    finished: endFrame.gameState === 'finished',
    lengthMs: Date.parse(endFrame.rfc460Timestamp) - startMs,
    blueKills: b.totalKills ?? null,
    redKills: r.totalKills ?? null,
    blueTowers: b.towers ?? 0,
    redTowers: r.towers ?? 0,
    blueInhibitors: b.inhibitors ?? 0,
    redInhibitors: r.inhibitors ?? 0,
    blueGold: b.totalGold ?? 0,
    redGold: r.totalGold ?? 0
  };
}

/** 取一场比赛的所有已完成小局（含蓝红方队伍、用时、击杀、终局态势） */
async function fetchMatchGames(matchId, timeoutMs, maxGames) {
  const res = await fetchJson(`${API_BASE}/getEventDetails?hl=zh-CN&id=${matchId}`, timeoutMs, ESPORTS_HEADERS);
  if (res.error || !res.data?.data?.event?.match) return null;
  const match = res.data.data.event.match;
  const codeById = {};
  for (const t of match.teams || []) codeById[t.id] = t.code || t.name || '?';

  const games = (match.games || []).filter((g) => g.state === 'completed').slice(0, maxGames);
  const detail = await mapLimit(games, 4, async (g) => {
    const blueTeam = (g.teams || []).find((t) => t.side === 'blue');
    const redTeam = (g.teams || []).find((t) => t.side === 'red');
    const info = await fetchGameEnd(g.id, timeoutMs);
    return {
      number: g.number,
      blue: codeById[blueTeam?.id] || '?',
      red: codeById[redTeam?.id] || '?',
      info: info || null
    };
  });
  return { teams: match.teams || [], games: detail };
}

/**
 * 由官方终局数据判定单局胜方：先看破水晶数，再看推塔数，再看经济，最后看击杀。
 * 全部持平则返回 null（宁可不写，也不猜）。
 */
function judgeGameWinner(info) {
  if (!info || !info.finished) return null;
  const dI = info.blueInhibitors - info.redInhibitors;
  if (dI !== 0) return dI > 0 ? 'blue' : 'red';
  const dT = info.blueTowers - info.redTowers;
  if (dT !== 0) return dT > 0 ? 'blue' : 'red';
  const dG = info.blueGold - info.redGold;
  if (dG !== 0) return dG > 0 ? 'blue' : 'red';
  const dK = info.blueKills - info.redKills;
  if (dK !== 0) return dK > 0 ? 'blue' : 'red';
  return null;
}

/**
 * 给小局逐个标上胜者，并与官方大比分交叉校验。返回 { rows, mismatch }。
 *
 * 纪律（改过一次，勿回退）：
 *   胜者**只**取 livestats 终局数据的逐局判定结果。早期版本一旦发现和官方 gameWins
 *   合计不一致，就按优势度"重新分配"胜者去凑出官方比分 —— 那本质是在编造每小局的
 *   赢家。现在改成：以逐局判定为准，合计对不上就**如实告警**（mismatch 非 null），
 *   由调用方在文本里提示"请以官方大比分为准"。
 *   judgeGameWinner 判不出的小局 winnerCode 为 null，渲染成「胜方未判定」，绝不猜。
 */
function reconcileGames(games, teams) {
  const t1 = teams?.[0];
  const t2 = teams?.[1];
  const code1 = t1?.code || t1?.name || '';
  const code2 = t2?.code || t2?.name || '';
  const w1 = t1?.result?.gameWins ?? null;
  const w2 = t2?.result?.gameWins ?? null;

  const rows = games.map((g) => {
    const side = g.info ? judgeGameWinner(g.info) : null;
    let winnerCode = null;
    if (side === 'blue') winnerCode = g.blue;
    else if (side === 'red') winnerCode = g.red;
    return { number: g.number, blue: g.blue, red: g.red, info: g.info, winnerCode };
  });

  let mismatch = null;
  // 只有**每一局**都判定出了胜方，合计才有资格和官方大比分比对。
  // 有判不出的局（livestats 缺数据/判不出）时合计不完整——拿"1:1"去说"与官方 2:1
  // 不一致"就是误报（G3 时序 bug 的次生灾害，QA 拨钟注入复现过），必须忍住不报。
  if (w1 != null && w2 != null && rows.length > 0 && rows.every((r) => r.winnerCode)) {
    const c1 = rows.filter((r) => r.winnerCode === code1).length;
    const c2 = rows.filter((r) => r.winnerCode === code2).length;
    if (c1 !== w1 || c2 !== w2) {
      mismatch = { official: `${w1}:${w2}`, judged: `${c1}:${c2}` };
    }
  }
  return { rows, mismatch };
}

/**
 * 把小局数据渲染成「G1 C9 30:41（击杀 LYON 6:20 C9）」这样的片段。
 * ⚠️ 绝不能丢行：没有 info 的局（livestats 没取到）也要渲染成「G3 胜方未判定」——
 * 旧实现 `if (!r.info) continue` 会让该局凭空消失（G3 时序 bug 的直接病灶）。
 * 此时没有用时和击杀数据，就不写，绝不编。
 */
function renderGames(rows) {
  const parts = [];
  for (const r of rows) {
    if (!r.info) {
      parts.push(`G${r.number} 胜方未判定`);
      continue;
    }
    const len = fmtDuration(r.info.lengthMs);
    // 击杀数按蓝:红排列，必须带上双方队名，否则容易被读错方向
    let kills = '';
    if (r.info.blueKills != null && r.info.redKills != null) {
      kills = `（击杀 ${r.blue} ${r.info.blueKills}:${r.info.redKills} ${r.red}）`;
    }
    const who = r.winnerCode ? r.winnerCode : '胜方未判定';
    parts.push(`G${r.number} ${who} ${len}${kills}`);
  }
  return parts;
}

// ── 备用源 3：Leaguepedia Cargo API（实测限流极频繁基本不可用，仅最后一级兜底）──
async function leaguepediaResults(filters, timeoutMs, days) {
  const now = new Date();
  const to = now.toISOString().replace('T', ' ').slice(0, 19);
  const from = new Date(now.getTime() - days * 86400000).toISOString().replace('T', ' ').slice(0, 19);
  const where = `MS.DateTime_UTC BETWEEN "${from}" AND "${to}"`;
  const url = `${LEAGUEPEDIA_API}?action=cargoquery&format=json&formatversion=2`
    + `&tables=MatchSchedule=MS`
    + `&fields=MS.DateTime_UTC,MS.Team1,MS.Team2,MS.OverviewPage,MS.Tab,MS.BestOf,MS.Winner,MS.Team1Score,MS.Team2Score`
    + `&where=${encodeURIComponent(where)}&order_by=MS.DateTime_UTC DESC&limit=50`;
  const res = await fetchJson(url, timeoutMs, null);
  if (res.error) return { error: res.error };
  const payload = res.data;
  // 实测：限流时返回 HTTP 200 + {"error":{"code":"ratelimited", ...}}
  if (payload?.error) {
    return { error: `Leaguepedia 返回错误：${payload.error.code || payload.error.info || '未知'}` };
  }
  const rows = payload?.cargoquery || [];
  const matches = [];
  for (const row of rows) {
    const t = row?.title || {};
    const ts = Date.parse(String(t['DateTime UTC'] || '').replace(' ', 'T') + 'Z');
    const team1 = t['Team1'] || '';
    const team2 = t['Team2'] || '';
    if (!team1 || !team2) continue;
    const item = {
      eventId: null,
      ts: isFinite(ts) ? ts : 0,
      team1,
      team2,
      code1: team1,
      code2: team2,
      score1: t['Team1Score'] != null && t['Team1Score'] !== '' ? Number(t['Team1Score']) : null,
      score2: t['Team2Score'] != null && t['Team2Score'] !== '' ? Number(t['Team2Score']) : null,
      leagueName: t['OverviewPage'] || '',
      leagueSlug: '',
      stage: t['Tab'] || '',
      bestOf: t['BestOf'] != null ? Number(t['BestOf']) : null,
      state: 'completed',
      _src: 'leaguepedia'
    };
    if (filters.length && !(matchTeam({ code: team1, name: team1 }, filters) || matchTeam({ code: team2, name: team2 }, filters))) {
      continue;
    }
    matches.push(item);
  }
  if (!matches.length) return { error: 'Leaguepedia 未返回可用数据' };
  return { matches: matches.sort((a, b) => b.ts - a.ts) };
}

// ── 备用源 2：Liquipedia 全站比赛聚合页（官方源失败时的补充来源）───────────────
/**
 * 数据口径（用户 2026-10-04 定）：第三方站点只允许当**官方接口失败时的补充来源**，
 * 不做第三方比对、不打分、不标注"与官方一致/不一致"；输出必须标明"非官方补充来源"，
 * 绝不声称数据经过验证或与官方核对一致。
 *
 * 实现：解析 Liquipedia:Matches 渲染后的 HTML（单请求，全站 upcoming+recent 各 50 场）。
 * 只在主源失败/为空时调用 1 次，遵守其 ToU（2 请求/秒 + 自报身份 UA）。
 */
async function liquipediaTicker(timeoutMs) {
  const url = `${LIQUID_API}?action=parse&page=${encodeURIComponent('Liquipedia:Matches')}&prop=text&format=json&formatversion=2`;
  const res = await fetchJson(url, timeoutMs, { 'User-Agent': LIQUID_UA });
  if (res.error) return { error: res.error };
  const html = String(res.data?.parse?.text || '');
  if (!html) return { error: '返回空内容' };
  const starts = [];
  const re = /<div class="match-info">/g;
  let m;
  while ((m = re.exec(html)) !== null) starts.push(m.index);
  const rows = [];
  for (let i = 0; i < starts.length; i++) {
    const block = html.slice(starts[i], i + 1 < starts.length ? starts[i + 1] : html.length);
    const row = parseLiquipediaBlock(block);
    if (row) rows.push(row);
  }
  if (!rows.length) return { error: '页面里没解析出任何比赛条目（页面结构可能变了）' };
  return { rows };
}

/** HTML 文本反转义（只需处理 ticker 里实际会出现的几个实体） */
function decodeHtmlText(s) {
  return String(s || '')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

/**
 * 解析单个 match-info 块 → 统一行结构。字段实测样例：
 *   <span class="timer-object" data-format="full" data-timestamp="1791057600"
 *         data-finished="finished">October 3, 2026 - 15:00 <abbr ...>CDT</abbr></span>
 *   左队 <div class="match-info-header-opponent match-info-header-opponent-left ...">
 *   比分 <span class="match-info-header-scoreholder-score">1</span> : <span ...winner>3</span>
 * 解析不出时间或两支队伍就整块丢弃（宁缺勿错）。
 */
function parseLiquipediaBlock(block) {
  const tsSec = Number((block.match(/data-timestamp="(\d+)"/) || [])[1]);
  if (!Number.isFinite(tsSec) || tsSec <= 0) return null;
  const finished = /data-finished="finished"/.test(block);

  // 左右两个 opponent 块；队名锚点只认 <span class="name"> 里的那个，
  // title 属性是全称（如 Cloud9 / FURIA），锚点文本是缩写（C9 / FUR）
  const oppRe = /<div class="match-info-header-opponent([^"]*)">[\s\S]*?<span class="name"[^>]*><a [^>]*?title="([^"]*)"[^>]*?>([^<]+)<\/a>/g;
  let left = null;
  let right = null;
  let om;
  while ((om = oppRe.exec(block)) !== null) {
    const entry = { name: decodeHtmlText(om[2]).trim(), code: decodeHtmlText(om[3]).trim() };
    if (/opponent-left/.test(om[1]) && !left) left = entry;
    else if (!right) right = entry;
  }
  if (!left || !right || !left.code || !right.code) return null;

  // 比分按出现顺序 左,右；类名精确匹配，避免抓到 scorewrapper 里的 "vs"/"(BoN)"
  const scoreRe = /class="match-info-header-scoreholder-score(?: match-info-header-winner)?"[^>]*>([^<]*)</g;
  const scores = [];
  let sm;
  while ((sm = scoreRe.exec(block)) !== null) scores.push(decodeHtmlText(sm[1]).trim());
  const score1 = scores.length > 0 && scores[0] !== '' ? Number(scores[0]) : null;
  const score2 = scores.length > 1 && scores[1] !== '' ? Number(scores[1]) : null;

  const bestOf = Number((block.match(/\(Bo(\d+)\)/) || [])[1]) || null;

  // 赛事名：链接 title 是页面路径，首段起、跳过 20xx 年份段：
  //   "LCS/2026/Summer/Playoffs#Playoffs" → LCS（阶段 Summer Playoffs）
  //   "LCK/Academy/2026/League/..."      → LCK Academy（避免青训混进 LCK）
  //   "World Championship/2026"          → World Championship
  const tpath = decodeHtmlText((block.match(/match-info-tournament[\s\S]{0,600}?<a [^>]*?title="([^"]+)"/) || [])[1] || '');
  const segs = tpath.split('#')[0].split('/').map((s) => s.trim().replace(/_/g, ' ')).filter(Boolean);
  const leagueParts = [];
  const stageParts = [];
  let yearSeen = false;
  for (const seg of segs) {
    if (!yearSeen && /^20\d{2}$/.test(seg)) { yearSeen = true; continue; }
    if (!yearSeen) leagueParts.push(seg);
    else stageParts.push(seg);
  }
  const leagueName = leagueParts.join(' ') || 'Liquipedia 赛事';
  const stage = stageParts.join(' ').slice(0, 60);

  const state = finished ? 'completed' : (score1 != null && score2 != null ? 'inProgress' : 'unstarted');
  return {
    eventId: null,
    ts: tsSec * 1000,
    team1: left.name || left.code,
    team2: right.name || right.code,
    code1: left.code,
    code2: right.code,
    score1,
    score2,
    leagueName,
    leagueSlug: '',
    stage,
    bestOf,
    state,
    teamsRaw: [
      { code: left.code, name: left.name || left.code, result: { gameWins: score1 } },
      { code: right.code, name: right.name || right.code, result: { gameWins: score2 } }
    ],
    _src: 'liquipedia'
  };
}

// ── 事件对象 → 统一的行结构 ───────────────────────────────────────────────
function normalizeEvent(e) {
  const teams = e?.match?.teams || [];
  const t1 = teams[0] || {};
  const t2 = teams[1] || {};
  return {
    eventId: e?.match?.id || null,
    ts: Date.parse(e?.startTime || ''),
    team1: t1.name || t1.code || '待定',
    team2: t2.name || t2.code || '待定',
    code1: t1.code || t1.name || '待定',
    code2: t2.code || t2.name || '待定',
    score1: t1.result?.gameWins ?? null,
    score2: t2.result?.gameWins ?? null,
    leagueName: e?.league?.name || '未知赛事',
    leagueSlug: e?.league?.slug || '',
    stage: e?.blockName || '',
    bestOf: e?.match?.strategy?.count ?? null,
    state: e?.state || 'unstarted',
    teamsRaw: teams
  };
}

export function setup(api) {
  cfg = typeof api.config === 'function' ? api.config : () => ({});
  httpFetch = typeof api.fetch === 'function' ? (...args) => api.fetch(...args) : null;
  logger = {
    log: typeof api.log === 'function' ? (...a) => api.log(...a) : () => {},
    warn: typeof api.warn === 'function' ? (...a) => api.warn(...a) : () => {},
    error: typeof api.error === 'function' ? (...a) => api.error(...a) : () => {}
  };

  // ── 工具1：赛程 ────────────────────────────────────────────────────────
  api.registerTool({
    id: 'recent_schedule',
    name: '英雄联盟赛程查询',
    category: 'knowledge',
    icon: '📅',
    description: '从 lolesports 官方公开接口抓取英雄联盟赛程，返回「今天 00:00 起」N 个自然日内的全部比赛（默认 3 天）：星期、北京时间、对阵双方、赛事名和赛制（BO几）。已结束的标 ✅ 并带上官方比分，进行中的标 ▶️，未开始的无标记——今天已经打完的比赛也会列出，不会丢。可用 teams 参数只查指定战队的比赛（中文名和外文缩写都行，如 京东、滔搏、BLG、T1、GEN、G2）；可用 leagues 参数只看用户点名的赛事（如 LPL、世界赛、德杯）；两者都不传时默认全部赛事都报，只有设置里手动开了「只看一线赛事」才按一线过滤，被过滤掉的场次会如实告知数量。用户问「今天/最近有哪些LOL比赛」「LOL明天/后天谁打谁」「LPL这周末赛程」「BLG下一场什么时候打」「只看世界赛的比赛」时使用。',
    parameters: {
      type: 'object',
      properties: {
        teams: {
          type: 'string',
          description: '可选，逗号分隔的战队名，只返回这些战队的比赛。中文名和外文缩写都认，例如「京东,滔搏」或「BLG,T1,GEN」。不传则返回全部（或按设置过滤）。'
        },
        leagues: {
          type: 'string',
          description: '可选，逗号分隔的赛事关键词，只返回这些赛事的比赛，如「LPL」「worlds,MSI」「德杯」。中文名（世界赛/季中赛/德杯/德玛西亚杯）和英文缩写都认。传了就以它为准（忽略设置里的「只看一线赛事」）；不传则默认全部赛事都报。'
        },
        days: {
          type: 'number',
          description: '查今天起几天，默认 3，最多 14。语义是「含今天在内的 N 个自然日」，所以 days=1 就是今天一整天。'
        }
      }
    },
    async execute(_ctx, args = {}) {
      if (!httpFetch) return { content: '未启用网络权限（web_fetch），无法查询英雄联盟赛事。', isError: true };

      const c = cfg() || {};
      const timeoutMs = clamp(c.timeoutMs, 3000, 30000, 12000);
      const tz = c.timeZone || 'Asia/Shanghai';
      // 「只看一线赛事」2026-10-04 起默认关闭（口径：默认全部赛事都报，按赛事看用 leagues 参数）
      const topOnly = c.topOnly === true;
      const topEvents = readList(c.topEvents);
      const filters = args?.teams ? readTeamList(args.teams) : readTeamList(c.filterTeams);
      const hasTeamFilter = filters.length > 0;
      const leaguesRaw = readList(args?.leagues);
      const leagueMode = leaguesRaw.length > 0;
      // leagues 非空 → 按点名的赛事过滤（最高优先级）；否则只在用户手动开了 topOnly 时按一线过滤
      const filterMode = leagueMode ? 'leagues' : (!hasTeamFilter && topOnly && topEvents.length ? 'top' : null);
      // 点名战队时把默认窗口放宽到 7 天（默认 3 天经常一场都捞不到）
      const days = clamp(args?.days, 1, 14, hasTeamFilter ? 7 : 3);
      const max = clamp(c.maxResults, 1, 20, 8);

      // 战队过滤（主源/备用源共用）
      const applyTeamFilter = (rows) => (hasTeamFilter
        ? rows.filter((m) => matchTeam({ code: m.code1, name: m.team1 }, filters)
          || matchTeam({ code: m.code2, name: m.team2 }, filters))
        : rows);
      // 赛事过滤（leagues 优先，其次 topOnly）；被过滤掉的逐条计数，不许静默丢
      const applyLeagueFilter = (rows) => {
        let hidden = 0;
        const leagues = new Set();
        if (!filterMode) return { rows, hidden, leagues };
        const kept = rows.filter((m) => {
          const lg = { name: m.leagueName, slug: m.leagueSlug };
          const keep = filterMode === 'leagues'
            ? leaguesRaw.some((t) => leagueMatchesToken(lg, t))
            : isTopLeague(lg, topEvents);
          if (!keep) { hidden += 1; leagues.add(m.leagueName); }
          return keep;
        });
        return { rows: kept, hidden, leagues };
      };

      // ── 主源：lolesports ──
      const got = await collectEvents('newer', 4, timeoutMs);
      const now = Date.now();
      // 时间窗 =「含今天在内的 N 个自然日」，起点是当地当天 00:00。
      // 旧实现用 now-6h ~ now+N*24h 的相对窗口，北京时间下午查当天赛程时，
      // 当天凌晨/上午已结束的比赛会整批掉出窗口（见文件头实测结论）。
      const dayStart = startOfDayInTz(now, tz);
      const windowEnd = dayStart + days * 86400000;

      let rows = [];
      let hiddenByFilter = 0;
      const hiddenLeagues = new Set();
      let mainError = null;
      let totalInWindow = 0;
      if (got.error) {
        mainError = got.error;
      } else {
        // ⚠️ 绝不在这里按 state 过滤掉已结束的比赛：用户问「今天有什么比赛」时，
        // 今天已经打完的必须照样列出（用 ✅ 标注 + 带上官方比分），否则就是数据丢失。
        const winRows = got.events
          .filter((e) => e?.type === 'match')
          .map(normalizeEvent)
          .filter((m) => isFinite(m.ts) && m.ts >= dayStart && m.ts < windowEnd)
          .sort((a, b) => a.ts - b.ts);
        totalInWindow = winRows.length;
        const f = applyLeagueFilter(applyTeamFilter(winRows));
        rows = f.rows;
        hiddenByFilter = f.hidden;
        for (const l of f.leagues) hiddenLeagues.add(l);
      }

      // ── 主源失败/为空 → Liquipedia 兜底（非官方补充来源，输出必须标注）──
      // 口径：第三方只作官方失败时的补充，不做比对，不得出现"经过验证/核对"类字样。
      let usedSource = 'lolesports';
      let srcIsOfficial = true;
      let backupNote = '';
      if (!rows.length) {
        const liq = await liquipediaTicker(timeoutMs);
        if (liq.rows && liq.rows.length) {
          const liqRows = liq.rows
            .filter((m) => isFinite(m.ts) && m.ts >= dayStart && m.ts < windowEnd)
            .sort((a, b) => a.ts - b.ts);
          const f = applyLeagueFilter(applyTeamFilter(liqRows));
          if (f.rows.length) {
            rows = f.rows;
            hiddenByFilter = f.hidden;
            hiddenLeagues.clear();
            for (const l of f.leagues) hiddenLeagues.add(l);
            usedSource = 'Liquipedia';
            srcIsOfficial = false;
          } else if (!f.hidden) {
            backupNote = 'Liquipedia：该时段没有收录比赛';
          }
        } else if (liq.error) {
          backupNote = `Liquipedia：${liq.error}`;
        }
        if (!rows.length) {
          // 最后一级：Leaguepedia（实测限流频繁基本不可用，响应快、失败不拖时间）
          const lp = await leaguepediaResults(filters, timeoutMs, days);
          if (lp.matches && lp.matches.length) {
            const lpRows = lp.matches
              .filter((m) => isFinite(m.ts) && m.ts >= dayStart && m.ts < windowEnd)
              .sort((a, b) => a.ts - b.ts);
            const f = applyLeagueFilter(applyTeamFilter(lpRows));
            if (f.rows.length) {
              rows = f.rows;
              hiddenByFilter = f.hidden;
              hiddenLeagues.clear();
              for (const l of f.leagues) hiddenLeagues.add(l);
              usedSource = 'Leaguepedia';
              srcIsOfficial = false;
            } else if (!backupNote) {
              backupNote = 'Leaguepedia：该时段没有收录比赛';
            }
          } else if (lp.error) {
            backupNote = backupNote ? `${backupNote}；Leaguepedia：${lp.error}` : `Leaguepedia：${lp.error}`;
          }
        }
      }

      const scopeLabel = hasTeamFilter
        ? `战队「${filters.join('、')}」`
        : (leagueMode ? `赛事「${leaguesRaw.join('、')}」` : (filterMode === 'top' ? '一线赛事' : '全部赛事'));

      const srcLabel = srcIsOfficial
        ? '（数据源：lolesports 官方接口）'
        : `（数据源：${usedSource}，非官方补充来源）`;

      if (!rows.length) {
        // 主源挂了（备用源也没救回来）是"数据源不可用"，不是"没有比赛"——
        // 必须标 isError:true，让模型转述故障而不是转述空结果
        if (mainError) {
          let msg = `今天起 ${days} 天的英雄联盟赛程查询失败：数据源暂时不可用。主源出错：${mainError}。`;
          if (backupNote) msg += `备用源也不可用：${backupNote}。`;
          msg += '请稍后重试。';
          return { content: msg, isError: true };
        }
        let msg = `今天起 ${days} 天没有查到 ${scopeLabel} 的英雄联盟赛程${srcLabel}。`;
        if (backupNote) msg += `备用源本次未取到数据：${backupNote}。`;
        if (filterMode === 'top' && totalInWindow) {
          msg += `该时段数据源里共 ${totalInWindow} 场比赛，但都不属于设置里的一线赛事。可在技能设置里关闭「只看一线赛事」查看全部。`;
        } else if (filterMode === 'leagues' && totalInWindow) {
          msg += `该时段数据源里共 ${totalInWindow} 场比赛，但都不属于「${leaguesRaw.join('、')}」。请确认赛事关键词写法（如 LPL、LCK、世界赛、德杯）。`;
        } else if (hasTeamFilter) {
          msg += '请确认战队名写法，或换别的队试试。';
        }
        return { content: msg };
      }

      // 有明确对阵的排前面，TBD vs TBD 沉到最后，再截断
      // （远程日期的占位条目按时间排在最前，会把真实对阵挤出 maxResults）
      rows = rows.sort((a, b) => {
        const ta = isTbdRow(a) ? 1 : 0;
        const tb = isTbdRow(b) ? 1 : 0;
        if (ta !== tb) return ta - tb;
        return a.ts - b.ts;
      });
      const droppedByMax = Math.max(0, rows.length - max);
      rows = rows.slice(0, max);

      const lines = rows.map((m) => {
        const bo = m.bestOf ? `BO${m.bestOf}` : '赛制待定';
        const stage = m.stage ? `${m.stage}·` : '';
        return `· ${scheduleStatePrefix(m.state)}${fmtTime(m.ts, tz)}｜${m.leagueName} ${stage}${bo}｜${renderMatchup(m)}`;
      });

      // 被过滤掉的东西必须说出来，不能静默丢失；提示行只在真的发生了过滤时出现
      const notes = [];
      if (hiddenByFilter > 0) {
        const names = [...hiddenLeagues].slice(0, 6).join('、');
        if (filterMode === 'leagues') {
          notes.push(`另有 ${hiddenByFilter} 场不属于「${leaguesRaw.join('、')}」的比赛未显示（${names}）；不传 leagues 参数即可看全部。`);
        } else {
          notes.push(`另有 ${hiddenByFilter} 场非一线赛事未显示（${names}）；想看全部可在技能设置里关闭「只看一线赛事」。`);
        }
      }
      if (droppedByMax > 0) {
        // 截断提示与赛事过滤提示（另有 N 场…未显示）措辞区分开：
        // 「另有 N 场」专指按赛事/一线过滤掉的，截断只说"超出单次返回上限"
        notes.push(`其余 ${droppedByMax} 场因超出单次返回上限（当前 ${max} 场）未列出，可调大「最多返回几场」设置。`);
      }

      const finishedCount = rows.filter((m) => m.state === 'completed').length;
      const scopeNote = finishedCount ? `，含已结束 ${finishedCount} 场` : '';
      const tzLabel = tz === 'Asia/Shanghai' ? '北京时间' : tz;
      // 来源行：官方就写官方；第三方必须明确标注"非官方补充来源"，
      // 不得出现任何"经过验证/与官方比对"类字样（用户 2026-10-04 口径）
      const srcLine = srcIsOfficial
        ? `（${tzLabel}，来自 lolesports 官方接口；✅=已结束 ▶️=进行中，含今天已结束的比赛）`
        : `（${tzLabel}，来自 ${usedSource}——非官方补充来源，数据可能不全或有滞后，仅供参考，请以官方渠道发布为准；✅=已结束 ▶️=进行中）`;
      let content = `📅 英雄联盟 今天起 ${days} 天${scopeLabel}赛程（共 ${rows.length} 场${scopeNote}）：\n${lines.join('\n')}\n\n${srcLine}`;
      if (notes.length) content += `\n${notes.join('\n')}`;
      return { content };
    }
  });

  // ── 工具2：赛果 ────────────────────────────────────────────────────────
  api.registerTool({
    id: 'recent_results',
    name: '英雄联盟近期赛果',
    category: 'knowledge',
    icon: '🏆',
    description: '查询英雄联盟最近几天已结束的比赛结果，返回对阵、大比分（BO几几比几）、赛事与阶段，并对最近几场展开每一小局：谁赢、用时多少、双方总击杀（如 G1 BLG 32:15（击杀 22:13））。可用 teams 参数只查指定战队（中文名或外文缩写）；可用 leagues 参数只看用户点名的赛事（如 LPL、世界赛、德杯）；两者都不传时默认全部赛事都报，只有设置里手动开了「只看一线赛事」才按一线过滤，点名战队时一线过滤自动失效，次级赛事也报。用户问「昨天/最近LOL赛果」「LPL昨天比分」「BLG最近战绩」「T1上一场赢了没」「只看德杯赛果」时使用。',
    parameters: {
      type: 'object',
      properties: {
        teams: {
          type: 'string',
          description: '可选，逗号分隔的战队名，只返回这些战队的比赛。中文名和外文缩写都认，例如「京东,滔搏」或「BLG,T1」。不传则返回全部（或按设置过滤）。'
        },
        leagues: {
          type: 'string',
          description: '可选，逗号分隔的赛事关键词，只返回这些赛事的比赛，如「LPL」「worlds,MSI」「德杯」。中文名（世界赛/季中赛/德杯/德玛西亚杯）和英文缩写都认。传了就以它为准（忽略设置里的「只看一线赛事」）；不传则默认全部赛事都报。'
        },
        days: {
          type: 'number',
          description: '查最近几天已结束的比赛，默认 3，最多 14。语义同样是「含今天在内的 N 个自然日」，与赛程工具口径一致。'
        },
        withGames: {
          type: 'boolean',
          description: '是否展开每小局的胜负、用时和击杀，默认 true。设 false 则只给大比分，返回更快。'
        }
      }
    },
    async execute(_ctx, args = {}) {
      if (!httpFetch) return { content: '未启用网络权限（web_fetch），无法查询英雄联盟赛果。', isError: true };

      const c = cfg() || {};
      const timeoutMs = clamp(c.timeoutMs, 3000, 30000, 12000);
      const tz = c.timeZone || 'Asia/Shanghai';
      // 「只看一线赛事」2026-10-04 起默认关闭（口径：默认全部赛事都报，按赛事看用 leagues 参数）
      const topOnly = c.topOnly === true;
      const topEvents = readList(c.topEvents);
      const filters = args?.teams ? readTeamList(args.teams) : readTeamList(c.filterTeams);
      const hasTeamFilter = filters.length > 0;
      const leaguesRaw = readList(args?.leagues);
      const leagueMode = leaguesRaw.length > 0;
      // leagues 非空 → 按点名的赛事过滤（最高优先级）；否则只在用户手动开了 topOnly 时按一线过滤
      const filterMode = leagueMode ? 'leagues' : (!hasTeamFilter && topOnly && topEvents.length ? 'top' : null);
      // 点名战队时把默认窗口放宽到 7 天（默认 3 天经常一场都捞不到）
      const days = clamp(args?.days, 1, 14, hasTeamFilter ? 7 : 3);
      const max = clamp(c.maxResults, 1, 20, 8);
      const maxGameDetail = clamp(c.maxGameDetail, 0, 5, 2);
      const wantGames = args?.withGames !== false;

      // 战队过滤（主源/备用源共用）
      const applyTeamFilter = (rows) => (hasTeamFilter
        ? rows.filter((m) => matchTeam({ code: m.code1, name: m.team1 }, filters)
          || matchTeam({ code: m.code2, name: m.team2 }, filters))
        : rows);
      // 赛事过滤（leagues 优先，其次 topOnly）；被过滤掉的逐条计数，不许静默丢
      const applyLeagueFilter = (rows) => {
        let hidden = 0;
        const leagues = new Set();
        if (!filterMode) return { rows, hidden, leagues };
        const kept = rows.filter((m) => {
          const lg = { name: m.leagueName, slug: m.leagueSlug };
          const keep = filterMode === 'leagues'
            ? leaguesRaw.some((t) => leagueMatchesToken(lg, t))
            : isTopLeague(lg, topEvents);
          if (!keep) { hidden += 1; leagues.add(m.leagueName); }
          return keep;
        });
        return { rows: kept, hidden, leagues };
      };

      // ── 主源：lolesports 赛程接口往过去翻页 ──
      let matches = [];
      let usedSource = 'lolesports';
      let srcIsOfficial = true;
      let mainError = null;
      let totalInWindow = 0;
      let hiddenByFilter = 0;
      const hiddenLeagues = new Set();
      let droppedByMax = 0;
      let backupNote = '';

      const got = await collectEvents('older', 4, timeoutMs);
      // 时间窗统一自然日语义，保证「今天」在赛程和赛果两个工具里是同一天：
      // 含今天在内的最近 N 个自然日，起点 = (今天00:00 - (N-1)天)，终点 = 明天 00:00
      const now = Date.now();
      const todayStart = startOfDayInTz(now, tz);
      const floor = todayStart - (days - 1) * 86400000;
      const ceil = todayStart + 86400000;

      if (got.error) {
        mainError = got.error;
      } else {
        const winRows = got.events
          .filter((e) => e?.type === 'match')
          .filter((e) => e?.state === 'completed')
          .map(normalizeEvent)
          .filter((m) => isFinite(m.ts) && m.ts >= floor && m.ts < ceil)
          .sort((a, b) => b.ts - a.ts);
        totalInWindow = winRows.length;
        const f = applyLeagueFilter(applyTeamFilter(winRows));
        hiddenByFilter = f.hidden;
        for (const l of f.leagues) hiddenLeagues.add(l);
        droppedByMax = Math.max(0, f.rows.length - max);
        matches = f.rows.slice(0, max);
      }

      // ── 主源失败/为空 → Liquipedia（非官方补充来源，输出必须标注）→ Leaguepedia（限流频繁，最后兜底）──
      if (!matches.length) {
        const liq = await liquipediaTicker(timeoutMs);
        if (liq.rows && liq.rows.length) {
          const liqRows = liq.rows
            .filter((m) => m.state === 'completed' && isFinite(m.ts) && m.ts >= floor && m.ts < ceil)
            .sort((a, b) => b.ts - a.ts);
          const f = applyLeagueFilter(applyTeamFilter(liqRows));
          if (f.rows.length) {
            hiddenByFilter = f.hidden;
            hiddenLeagues.clear();
            for (const l of f.leagues) hiddenLeagues.add(l);
            droppedByMax = Math.max(0, f.rows.length - max);
            matches = f.rows.slice(0, max);
            usedSource = 'Liquipedia';
            srcIsOfficial = false;
          } else if (!f.hidden) {
            backupNote = 'Liquipedia：该时段没有已结束的比赛';
          }
        } else if (liq.error) {
          backupNote = `Liquipedia：${liq.error}`;
        }
        if (!matches.length) {
          // 最后一级：Leaguepedia（实测限流频繁基本不可用，响应快、失败不拖时间）
          const lp = await leaguepediaResults(filters, timeoutMs, days);
          if (lp.matches && lp.matches.length) {
            const lpRows = lp.matches
              .filter((m) => isFinite(m.ts) && m.ts >= floor && m.ts < ceil)
              .sort((a, b) => b.ts - a.ts);
            const f = applyLeagueFilter(applyTeamFilter(lpRows));
            if (f.rows.length) {
              hiddenByFilter = f.hidden;
              hiddenLeagues.clear();
              for (const l of f.leagues) hiddenLeagues.add(l);
              droppedByMax = Math.max(0, f.rows.length - max);
              matches = f.rows.slice(0, max);
              usedSource = 'Leaguepedia';
              srcIsOfficial = false;
            } else if (!backupNote) {
              backupNote = 'Leaguepedia：该时段没有已结束的比赛';
            }
          } else if (lp.error) {
            backupNote = backupNote ? `${backupNote}；Leaguepedia：${lp.error}` : `Leaguepedia：${lp.error}`;
          }
        }
      }

      const scopeLabel = hasTeamFilter
        ? `战队「${filters.join('、')}」`
        : (leagueMode ? `赛事「${leaguesRaw.join('、')}」` : (filterMode === 'top' ? '一线赛事' : '全部赛事'));

      if (!matches.length) {
        // 主源挂了（备用源也没救回来）是"数据源不可用"，不是"没有比赛"——
        // 必须标 isError:true（与 recent_schedule 口径一致），让模型转述故障而不是转述空结果
        if (mainError) {
          let msg = `最近 ${days} 天的英雄联盟赛果查询失败：数据源暂时不可用。主源出错：${mainError}。`;
          if (backupNote) msg += `备用源也不可用：${backupNote}。`;
          msg += '请稍后重试。';
          return { content: msg, isError: true };
        }
        let msg = `最近 ${days} 天没有查到 ${scopeLabel} 已结束的英雄联盟比赛。`;
        if (backupNote) msg += `备用源本次未取到数据：${backupNote}。`;
        if (filterMode === 'top' && totalInWindow) {
          msg += `该时段数据源里共 ${totalInWindow} 场已结束比赛，但都不属于设置里的一线赛事；可在技能设置里关闭「只看一线赛事」查看全部。`;
        } else if (filterMode === 'leagues' && totalInWindow) {
          msg += `该时段数据源里共 ${totalInWindow} 场已结束比赛，但都不属于「${leaguesRaw.join('、')}」。请确认赛事关键词写法（如 LPL、LCK、世界赛、德杯）。`;
        } else if (hasTeamFilter) {
          msg += '请确认战队名写法，或换别的队试试。';
        }
        return { content: msg };
      }

      // ── 展开小局详情（只对最近几场，避免请求过多；备用源没有 eventId，自然跳过）──
      const detailCount = wantGames ? Math.min(maxGameDetail, matches.length) : 0;
      if (detailCount > 0) {
        await mapLimit(matches.slice(0, detailCount), 2, async (m) => {
          if (!m.eventId) return;
          try {
            const detail = await fetchMatchGames(m.eventId, timeoutMs, 5);
            if (!detail || !detail.games.length) return;
            const rec = reconcileGames(detail.games, m.teamsRaw || detail.teams);
            m.games = rec.rows;
            m.gamesMismatch = rec.mismatch;
          } catch (e) {
            logger.warn?.('lol-match: 小局详情抓取失败 %s', e?.message ?? String(e));
          }
        });
      }

      // 记录是否真的渲染出了小局，"本场没有小局数据"和"小局源挂了"要给不同说法
      let renderedGames = 0;
      let gotAnyInfo = 0; // 展开的场次里有没有真的拿到 livestats 数据；一行都没拿到时 footer 必须改口，不能谎称"用时与击杀来自 livestats"
      const lines = matches.map((m) => {
        const score = (m.score1 != null && m.score2 != null) ? `${m.score1}:${m.score2}` : '比分未收录';
        const bo = m.bestOf ? `BO${m.bestOf}` : '';
        const stage = m.stage ? `${m.stage}·` : '';
        let line = `· ${m.ts ? fmtTime(m.ts, tz) : '日期未知'}｜${m.leagueName} ${stage}${bo}｜${m.code1} ${score} ${m.code2}`;
        if (m.games && m.games.length) {
          const parts = renderGames(m.games);
          if (parts.length) {
            line += `\n    ${parts.join('、')}`;
            if (m.gamesMismatch) {
              const mm = m.gamesMismatch;
              line += `\n    ⚠️ 官方大比分 ${mm.official} 与逐局判定合计 ${mm.judged} 不一致，请以官方大比分为准`;
            }
            renderedGames += 1;
            gotAnyInfo += m.games.filter((r) => r.info).length;
          }
        }
        return line;
      });

      // 来源行：官方就写官方；第三方必须明确标注"非官方补充来源"，
      // 不得出现任何"经过验证/与官方比对"类字样（用户 2026-10-04 口径）
      let footer = srcIsOfficial
        ? '\n\n（来源：lolesports 官方接口）'
        : `\n\n（来源：${usedSource}——非官方补充来源，数据可能不全或有滞后，仅供参考，请以官方渠道发布为准）`;
      if (renderedGames > 0 && gotAnyInfo > 0) {
        footer += `\n小局的用时与击杀来自官方 livestats 终局数据；只展开了最近 ${renderedGames} 场，其余仅给大比分。`;
      } else if (detailCount > 0 && srcIsOfficial) {
        // 尝试过但一场都没抓到（小局源故障/该赛事未收录），如实说明，不谎称有数据
        footer += '\n本次未能取到小局数据（官方 livestats 未收录或暂时不可用），以上仅给出官方大比分。';
      }
      if (backupNote && srcIsOfficial) {
        footer += `\n（备用源本次未取到数据：${backupNote}）`;
      }
      // 过滤掉的东西必须说出来，不能静默丢失；提示行只在真的发生了过滤时出现
      if (hiddenByFilter > 0) {
        const names = [...hiddenLeagues].slice(0, 6).join('、');
        if (filterMode === 'leagues') {
          footer += `\n另有 ${hiddenByFilter} 场不属于「${leaguesRaw.join('、')}」的比赛未显示（${names}）；不传 leagues 参数即可看全部。`;
        } else {
          footer += `\n另有 ${hiddenByFilter} 场非一线赛事未显示（${names}）；想看全部可在技能设置里关闭「只看一线赛事」。`;
        }
      }
      if (droppedByMax > 0) {
        // 截断提示与赛事过滤提示（另有 N 场…未显示）措辞区分开（同赛程工具）
        footer += `\n其余 ${droppedByMax} 场因超出单次返回上限（当前 ${max} 场）未列出，可调大「最多返回几场」设置。`;
      }

      return {
        content: `🏆 最近 ${days} 天${scopeLabel}英雄联盟赛果（共 ${matches.length} 场）：\n${lines.join('\n')}${footer}`
      };
    }
  });
}

/** 自检：没有网络权限时明确报出来。 */
export function available() {
  if (!httpFetch) return { ok: false, reason: '缺少 web_fetch 权限（清单里的 permissions 被删了？）' };
  return true;
}
