// B 站视频分享技能（LLM 型 · registerTool）。
//
// ── 与 plugins/bili-video 的分工（这是本项目的核心设计，别搞混）─────────────
//   plugins/bili-video（确定性型）：群里**出现链接**就自动转发，不经过模型。
//   skills/bili-share（LLM 型，本文件）：**有人要求**时，模型主动找一条发出来。
//
// ⚠️ 两边 id 必须不同 —— 这里刻意叫 bili-share 而不是 bili-video。
// 实测教训：SkillManager 的注册表是 `id → 实例` 的 Map，**同 id 时后注册的直接
// 覆盖先注册的，且不报任何错**（manager.js 把这条写成"覆盖注册"，因为热重载依赖
// 这个语义）。第一版两边都叫 bili-video，结果插件把技能整个吃掉了：界面上只剩一个
// 条目，而启动日志里两行"✅ 加载成功"都还在，极具误导性。
//
// 两边各自目录内放一份 bili-api.js（保持"扩展目录自包含"，不跨目录 import）——
// 这样删掉其中一个，另一个照样能跑。
//
// ── 依赖说明 ──────────────────────────────────────────────────────────────
// 不声明 web_fetch 权限：本技能只用 Node 内置 fetch 与 B 站官方接口，
// 不用 api.fetch。少一个权限就少一个失败点。
// 发送一律走 ctx.sender（串行/限频/去重/留档），与点歌技能同一口径。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  pickBiliLink, pickBareVideoToken, resolveLink, fetchVideoInfo, getPlayUrl,
  downloadVideo, safeFileName, shareCaption, qualityLabel, searchVideos,
  searchUpUser, fetchUpVideos
} from './bili-api.js';

let cfg = () => ({});
let log = () => {};
let warn = () => {};

// ⚠️ 入口函数**只能叫 setup**，不能叫 register，也不能两个都导出。
//
// 实测教训（本项目最容易踩、且完全不报错的坑）：加载器取入口的顺序是
//   setupFn = typeof mod.setup === 'function' ? mod.setup : mod.register
//   —— setup 优先，register 只是旧版兼容。
// 第一版我同时导出了 setup(只存配置) 和 register(注册工具)，加载器选了 setup，
// 于是注册工具那段代码**从未被执行**：技能页显示"加载成功 / 生效中"，但
// /api/skills 的 toolIds 是空的，模型根本看不到这个工具 —— 静默失效。
// 现成的点歌技能（skills/music）只导出 setup 一个，这里对齐它的口径。
function ok(payload) { return { content: JSON.stringify(payload, null, 1) }; }
function err(message) { return { content: String(message), isError: true }; }

/** 落地目录：默认应用 data/bili-media；与插件同一套清理策略。 */
function mediaDir() {
  const configured = String(cfg().mediaDir || '').trim();
  if (configured) return configured;
  const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
  return path.join(appRoot, 'data', 'bili-media');
}

function pruneOldFiles(dir, maxAgeMs = 2 * 60 * 60 * 1000) {
  try {
    if (!fs.existsSync(dir)) return;
    const now = Date.now();
    for (const name of fs.readdirSync(dir)) {
      const p = path.join(dir, name);
      try {
        const st = fs.statSync(p);
        if (st.isFile() && now - st.mtimeMs > maxAgeMs) fs.unlinkSync(p);
      } catch { /* ignore */ }
    }
  } catch { /* ignore */ }
}

/** 从消息文本里抠出被引用消息 id（与插件同口径）。 */
function replyIdFromText(text) {
  const m = String(text || '').match(/\[引用[^\]]*?id[=:]\s*(-?\d+)/i);
  return m ? m[1] : null;
}

// ── 跨轮「这个关键词发过哪些视频」账本 ──────────────────────────────────────
//
// 为什么必须落盘、不能挂在 ctx 上（用户反馈的核心问题）：
//   「同一个关键词每次都被发同一条视频」。根因是记账挂在 ctx，而 ctx **每轮新建**
//   （项目本身就是"无状态会话"设计），下一轮账本清零 → 又从排序第一名开始 → 永远同一条。
//   翻页逻辑也因此失效：它只在本轮内累计页码。
// 所以改成进程内 + 磁盘双层：按关键词记已发过的 BV 号，新调用先排除它们。
//   · 内存：热路径不读盘
//   · 磁盘：应用重启后仍然记得（否则重启一次又开始重复第一条）
function storeFile() {
  return path.join(mediaDir(), 'sent-by-keyword.json');
}
const SENT_TTL_MS = 7 * 24 * 60 * 60 * 1000;   // 7 天没搜过这个词就忘掉，避免文件无限长大
let sentStore = null;

function loadSentStore() {
  if (sentStore) return sentStore;
  try {
    const raw = fs.readFileSync(storeFile(), 'utf8');
    const parsed = JSON.parse(raw);
    sentStore = (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) ? parsed : {};
  } catch {
    sentStore = {};   // 首次运行 / 文件损坏都从空开始，不能因此让功能失败
  }
  return sentStore;
}

function saveSentStore() {
  try {
    const dir = mediaDir();
    fs.mkdirSync(dir, { recursive: true });
    // 顺手清掉过期关键词，防止文件无限增长
    const now = Date.now();
    for (const [k, v] of Object.entries(sentStore || {})) {
      if (!v || !v.at || now - v.at > SENT_TTL_MS) delete sentStore[k];
    }
    fs.writeFileSync(storeFile(), JSON.stringify(sentStore), 'utf8');
  } catch (error) {
    // 写不进去不该让发送失败——大不了重启后忘记已发记录
    warn(`已发记录写盘失败（不影响发送）：${error?.message ?? error}`);
  }
}

function sentOf(keyword) {
  const rec = loadSentStore()[String(keyword)];
  return Array.isArray(rec?.bvids) ? rec.bvids : [];
}

function markSent(keyword, bvid, page) {
  const store = loadSentStore();
  const key = String(keyword);
  const rec = store[key] && Array.isArray(store[key].bvids) ? store[key] : { bvids: [], at: 0, page: 1 };
  if (bvid && !rec.bvids.includes(bvid)) rec.bvids.push(bvid);
  rec.at = Date.now();
  rec.page = Math.max(1, Number(page) || 1);
  // 最多记 200 条，够了（B 站一个词也就 3 页 60 条）
  if (rec.bvids.length > 200) rec.bvids = rec.bvids.slice(-200);
  store[key] = rec;
  saveSentStore();
}

function resetSent(keyword) {
  const store = loadSentStore();
  delete store[String(keyword)];
  saveSentStore();
}

// ── UP 主页投稿缓存 ────────────────────────────────────────────────────────
//
// 为什么必须缓存：空间投稿接口（/x/space/wbi/arc/search）**调勤了会被长时间限流**。
// 实测：间隔 3 秒连打几次就报「request was banned / 风控校验失败」，而且过了 6 分钟
// 仍未恢复。所以同一个 UP 的投稿列表缓存到磁盘（默认 6 小时），期间只看缓存不打接口。
const UP_TTL_MS = 6 * 60 * 60 * 1000;
let upStore = null;

function upStoreFile() {
  return path.join(mediaDir(), 'up-videos.json');
}

function loadUpStore() {
  if (upStore) return upStore;
  try {
    const parsed = JSON.parse(fs.readFileSync(upStoreFile(), 'utf8'));
    upStore = (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) ? parsed : {};
  } catch {
    upStore = {};
  }
  return upStore;
}

function saveUpStore() {
  try {
    fs.mkdirSync(mediaDir(), { recursive: true });
    const now = Date.now();
    for (const [k, v] of Object.entries(upStore || {})) {
      if (!v || !v.at || now - v.at > UP_TTL_MS * 4) delete upStore[k];   // 过期太久直接丢
    }
    fs.writeFileSync(upStoreFile(), JSON.stringify(upStore), 'utf8');
  } catch (error) {
    warn(`UP 投稿缓存写盘失败（不影响使用）：${error?.message ?? error}`);
  }
}

/** 取缓存的 UP 投稿；过期或没有则返回 null。 */
function cachedUpVideos(mid) {
  const rec = loadUpStore()[String(mid)];
  if (!rec || !Array.isArray(rec.items) || !rec.items.length) return null;
  if (Date.now() - (rec.at || 0) > UP_TTL_MS) return null;
  return rec;
}

function saveUpVideos(mid, items, total) {
  const store = loadUpStore();
  store[String(mid)] = { at: Date.now(), total: total || items.length, items: items.slice(0, 50) };
  saveUpStore();
}

/**
 * 真正干活的那条路径：解析 → 下载 → 发视频 + 文案。
 * 失败时**降级发文案**（标题 + 原链接），而不是什么都不发 ——
 * 模型说"我发给你"却什么都没出现，比发个链接难看得多。
 */
async function share({ link, ctx, replyToMessageId = null }) {
  const resolved = await resolveLink(link);
  if (resolved.error) return { ok: false, error: resolved.error };
  if (resolved.kind === 'unknown') return { ok: false, error: '这不是一个能识别的 B 站视频链接' };

  const info = await fetchVideoInfo(resolved);
  if (!info.ok) return { ok: false, error: info.error };

  const pageUrl = info.bvid
    ? `https://www.bilibili.com/video/${info.bvid}${info.page > 1 ? `?p=${info.page}` : ''}`
    : link;
  const caption = shareCaption(info, { link: pageUrl });
  const chatKey = ctx.chatKey;
  const sender = ctx.sender;

  const play = await getPlayUrl(info.bvid, info.cid, { qn: Number(cfg().qn) || 16 });
  if (!play.ok) {
    await sender.sendTextBatch(chatKey, [`${caption}\n（拉不到视频流，可能仅限登录/大会员观看）`]);
    return { ok: true, degraded: true, title: info.title, url: pageUrl, reason: play.error };
  }

  const maxMB = Math.max(1, Math.min(600, Number(cfg().maxMB) || 100));
  const maxBytes = maxMB * 1024 * 1024;
  if (play.sizeBytes && play.sizeBytes > maxBytes) {
    await sender.sendTextBatch(chatKey, [`${caption}\n（${(play.sizeBytes / 1048576).toFixed(1)}MB，超过 ${maxMB}MB 上限，给你链接）`]);
    return { ok: true, degraded: true, reason: 'too-large', title: info.title, url: pageUrl, sizeBytes: play.sizeBytes };
  }

  const dir = mediaDir();
  pruneOldFiles(dir);
  fs.mkdirSync(dir, { recursive: true });
  const dest = path.join(dir, safeFileName(info));
  const dl = await downloadVideo(play.urls, dest, {
    maxBytes,
    referer: pageUrl,
    timeoutMs: Math.max(15000, Number(cfg().timeoutMs) || 60000),
    log: (m) => log(`${path.basename(dest)} ${m}`)
  });
  if (!dl.ok) {
    try { if (fs.existsSync(dest)) fs.unlinkSync(dest); } catch { /* ignore */ }
    await sender.sendTextBatch(chatKey, [`${caption}\n（视频下载失败：${dl.error}）`]);
    return { ok: false, error: dl.error, url: pageUrl };
  }

  // ⚠️ 视频段必须**独占一条消息**，不能和文案拼在一起。
  // 实测：拼成 [{video},{text}] 发出去，协议端回
  //   retcode=1400 message element "video" must be the only segment in a message
  // 且失败发生在发送阶段 —— 视频已经下载完、文件已落盘才被拒，
  // 表现是"下载成功但群里什么都没有"。所以分两条发：先视频，后文案。
  await sender.sendMedia(chatKey, [{ type: 'video', data: { file: dest } }], {
    label: `[B站视频]:${String(info.title).slice(0, 40)}`,
    dedupeKey: dest,
    replyToMessageId
  });
  let captionSent = false;
  try {
    await sender.sendTextBatch(chatKey, [caption]);
    captionSent = true;
  } catch (error) {
    // 视频已经发出去了，文案失败不该让整次分享算失败
    warn(`视频已发出，但文案发送失败：${error?.message ?? error}`);
  }
  log(`已分享《${info.title}》（${info.author}，${qualityLabel(play.qn)}，${(dl.bytes / 1048576).toFixed(1)}MB）`);
  return {
    ok: true, title: info.title, author: info.author, url: pageUrl,
    quality: qualityLabel(play.qn), sizeMB: Number((dl.bytes / 1048576).toFixed(1)), captionSent,
    // ⚠️ filePath 必须回传：调用方（关键词分支）要用它记账，实现"同一轮重复调用时
    // 直接复用已下载的视频、不再下载一遍"。漏掉它 → 复用分支永远拿不到路径，
    // 防重复就形同虚设（而且不会有任何报错，只是默默地又下一遍）。
    filePath: dest
  };
}

/**
 * 唯一入口（名字必须是 setup，见文件上方的实测教训）。
 * 职责两件：接管 api 里的 config/log/warn，并注册工具。
 */
export function setup(api) {
  cfg = api.config;
  log = api.log;
  warn = api.warn;

  /**
   * 把一个已选定的候选（{url,title,author,playText,duration}）真发出去，并记账。
   * up 模式与 keyword 模式共用这一段，避免两处各写一遍发送/记账逻辑而出岔子。
   */
  async function sendPicked(picked, { ctx, replyToMessageId, storeKey, page }) {
    const r = await share({ link: picked.url, ctx, replyToMessageId });
    if (!r.ok) return err(`选中的《${picked.title}》分享失败：${r.error}`);
    markSent(storeKey, picked.bvid, page);
    return ok({
      sent: true,
      picked: {
        title: picked.title, author: picked.author, url: picked.url,
        play: picked.play, playText: picked.playText
      },
      ...r,
      note: '视频已发出。下次同一个 UP／关键词会换一条没发过的；不要复述视频内容。'
    });
  }

  api.registerTool({
    id: 'bili_video',
    name: '分享B站视频',
    description: '把一个 B 站视频发到当前会话（下载视频本体 + 附标题/UP主/时长/原链接）。'
      + '三种用法：① 群友给了 B 站链接（含 b23.tv 短链）→ 传 link；'
      + '② 群友说了 UP 主的名字（"来个伊莫可Imoko的视频""有没有老番茄的"）→ 传 up，'
      + '   我会直接拉他主页里**播放量最高**的投稿（比关键词搜索精确得多，优先用这个）；'
      + '③ 只是个泛泛的词、没有明确 UP（"来点猫的视频"）→ 传 keyword 搜索。'
      + 'up 和 keyword 同时给时以 up 为准。一次只发一条，不要连发；不要重复发同一条。'
      + '注意：视频是下载转发的，你并没有看过内容，不要说"这个视频讲了什么"这类评述，'
      + '最多按标题/UP主说一句为什么挑它。',
    category: 'media',
    icon: '📺',
    parameters: {
      type: 'object',
      properties: {
        link: { type: 'string', description: 'B 站视频链接（bilibili.com / b23.tv 短链都行），也可直接给 BV 号' },
        up: { type: 'string', description: 'UP 主的名字（如"伊莫可Imoko"）。有明确 UP 时优先用它，会按播放量从他主页投稿里挑' },
        uid: { type: 'string', description: '可选：UP 主的 uid（数字）。知道 uid 时传它，比名字更准' },
        keyword: { type: 'string', description: '搜索关键词（没有明确 UP 时才用）' },
        pick: { type: 'number', description: '选第几个候选，默认 1（第一个）。up 模式按播放量降序，keyword 模式按设置里的排序' },
        replyToMessageId: { type: ['integer', 'string'], description: '可选：引用某条消息的 id' }
      }
    },
    async execute(ctx, args) {
      try {
        const replyToMessageId = args.replyToMessageId ?? replyIdFromText(ctx.text) ?? null;
        const link = String(args.link || '').trim();
        const keyword = String(args.keyword || '').trim();
        const upName = String(args.up || '').trim();
        const uidArg = String(args.uid || '').trim();
        const pickNo = Math.min(Math.max(1, Number(args.pick) || 1), 10);

        if (link) {
          const normalized = pickBiliLink(link) || pickBareVideoToken(link) || link;
          const r = await share({ link: normalized, ctx, replyToMessageId });
          return r.ok
            ? ok({ sent: true, ...r, note: '视频已发出（视频段 + 文案段）。不要再补发链接或感谢语。' })
            : err(`分享失败：${r.error}`);
        }

        // ── UP 模式：直接拉某个 UP 主页的投稿（按播放量），不再靠关键词模糊匹配 ──
        // 为什么这是更好的路：关键词搜索会把别人的二创混进来（实测「伊莫可Imoko 鼠小妹」
        // 前 5 条只剩 2 条是本人），而空间接口是按 uid 精确取的，天然只有本人。
        if (upName || uidArg) {
          const c0 = cfg();
          // 1) 名字 → uid（给了 uid 就跳过这步）
          let mid = Number(uidArg) || 0;
          let uname = upName || String(uidArg);
          if (!mid) {
            const u = await searchUpUser(upName, { timeoutMs: Math.max(8000, Number(c0.timeoutMs) || 15000) });
            if (!u.ok) return err(`${u.error}。可以换个写法再试，或者直接给我他的 uid`);
            mid = u.best.mid;
            uname = u.best.uname;
            log(`UP「${upName}」→ uid ${mid}（${u.best.uname}，${u.best.videos} 个投稿，${u.best.fans} 粉）`);
          }

          // 2) 先看缓存（6 小时内不再打接口）——空间接口调勤了会被长时间限流
          const order = String(c0.upOrder || 'click');
          let pool = cachedUpVideos(mid);
          if (pool) {
            log(`UP ${mid} 用缓存的投稿列表（${pool.items.length} 条，缓存于 ${new Date(pool.at).toLocaleTimeString('zh-CN', { hour12: false })}）`);
          } else {
            const v = await fetchUpVideos(mid, { page: 1, ps: 50, order, timeoutMs: Math.max(8000, Number(c0.timeoutMs) || 15000) });
            if (!v.ok) {
              // 限流时把原因说清楚（原文案里已经带了冷却提示），并给出退路
              return err(`${v.error}${v.banned ? '' : '（也可以改用关键词搜索：传 keyword）'}`);
            }
            pool = { at: Date.now(), total: v.total, items: v.items };
            saveUpVideos(mid, v.items, v.total);
            log(`已拉取 UP ${mid} 的投稿 ${v.items.length} 条（共 ${v.total} 个）`);
          }

          // 3) 排除已发过的，按播放量降序挑（接口已按 click 排好，缓存里也是这个序）
          const sentBv = sentOf(`up:${mid}`);
          const fresh = pool.items.filter((x) => !sentBv.includes(x.bvid));
          if (!fresh.length) {
            // 缓存里的都发完了：重置账本重新轮（不用重新打接口）
            resetSent(`up:${mid}`);
            const again = pool.items.filter(Boolean);
            if (!again.length) return err(`「${uname}」我没拿到可发的投稿`);
            const chosen = again[Math.min(pickNo, again.length) - 1];
            log(`「${uname}」缓存里的投稿都发过一轮了，重置后重新开始`);
            return await sendPicked(chosen, { ctx, replyToMessageId, storeKey: `up:${mid}`, page: 1 });
          }
          const chosen = fresh[Math.min(pickNo, fresh.length) - 1];
          return await sendPicked(chosen, { ctx, replyToMessageId, storeKey: `up:${mid}`, page: 1 });
        }

        if (!keyword) return err('需要 link（链接）、up（UP 主名字）或 keyword（搜索词）其中之一');

        // ── 防重复 + 自动翻页 ─────────────────────────────────────────────────
        // 实测背景一：协议端掉线时，模型在**同一轮里连调了 6 次 bili_video** 反复试探，
        // 每次都重新搜索 + 重新下载同一个视频（发送阶段的去重只挡"重复发"，
        // 挡不住"已经下载完了"）。
        // 实测背景二：接口每页只给 20 条，而代码只取第 1 页 —— 同一个词反复搜就永远是
        // 那几条，用户反馈"来回就那几个视频"。
        // 所以这里按关键词记账：同一个词再来时**自动翻到下一页**，页数用尽才进冷却。
        // （pickNo 已在 execute 开头统一解析，这里不再重复声明）
        const COOLDOWN_MS = 30000;
        const MAX_PAGE = 3;
        ctx.biliCache = ctx.biliCache || { lastCall: new Map() };
        const c = cfg();

        // 本轮内完全相同的重复调用才拦（防模型掉线时连试 6 次那种刷屏）。
        // ⚠️ 冷却只活在本轮 ctx 里，**跨轮的"换一个视频"不能被它挡** —— 那正是用户要的。
        const cacheKey = `${keyword}||${pickNo}`;
        if (Date.now() < (ctx.biliCache.lastCall.get(cacheKey) || 0)) {
          return ok({ sent: 0, note: `「${keyword}」这一轮刚发过，同一轮里不要重复调用；要换一个就直接再调一次（下一轮）。` });
        }

        // 账本：这个关键词已经发过哪些 BV（跨轮、跨重启都记得）
        const sentBvids = sentOf(keyword);
        const lastPage = Number(loadSentStore()[String(keyword)]?.page) || 1;

        // 从上次那一页开始搜；本页全发完了就往后翻，最多到 MAX_PAGE。
        // 为什么要从"上次那页"起步：同一个词可能已经被发了十几条，前面的页早已掏空，
        // 每次都从第 1 页重搜会白跑请求还总是筛出空结果。
        let picked = null;
        let usedPage = lastPage;
        let searchResult = null;
        for (let page = Math.max(1, lastPage); page <= MAX_PAGE; page += 1) {
          // 搜索池取 20 条本地排序（不花 token），默认 up-first：UP 本人的优先。
          // 已发过的用 excludeBvids 排掉 —— 这是"永远发同一条"的根治点。
          // eslint-disable-next-line no-await-in-loop
          const s = await searchVideos(keyword, {
            page,
            limit: 10,
            fetchLimit: 20,
            sortBy: String(c.sortBy || 'up-first'),
            maxDurationSec: Number(c.maxDurationSec) || 1800,
            minDurationSec: Number(c.minDurationSec) || 0,
            fuzzy: c.fuzzySearch !== false,
            excludeBvids: sentBvids,
            log
          });
          if (!s.ok) return err(`搜索失败：${s.error}`);
          searchResult = s;
          if (s.suggestion) log(`关键词「${keyword}」被建议纠正为「${s.suggestion}」`);
          if (s.items.length) {
            picked = s.items[Math.min(pickNo, s.items.length) - 1];
            usedPage = page;
            break;
          }
          // 词本身搜不到内容（关键词校验把不相关的全滤掉了）→ 立即如实回报，
          // 别继续翻页/回绕：那会白跑请求，而且回绕后还是搜不到，等于把"搜不到"
          // 伪装成"都发过了"。用户要的是"别发垃圾"，不是"硬凑一条"。
          if (s.keywordMiss) {
            return err(`${s.error || `「${keyword}」没搜到内容匹配的视频`}。换个更准确的关键词试试`
              + `（比如只留主体词，别加"新手/教学/玩法"这类修饰）；如果知道 UP 名字，用 up 参数更准。`);
          }
        }

        if (!picked) {
          // 全部掏空（3 页都没剩没发过的）→ 回绕重置，从头再轮一遍。
          // 回绕而不是"永远拒绝"：用户明确点这个关键词时，他就是要看内容，
          // 宁可从头再来一轮，也比什么都不发生好。回绕时如实说明。
          resetSent(keyword);
          const s2 = await searchVideos(keyword, {
            page: 1, limit: 10, fetchLimit: 20,
            sortBy: String(c.sortBy || 'up-first'),
            maxDurationSec: Number(c.maxDurationSec) || 1800,
            minDurationSec: Number(c.minDurationSec) || 0,
            fuzzy: c.fuzzySearch !== false,
            log
          });
          if (!s2.ok) return err(`搜索失败：${s2.error}`);
          if (!s2.items.length) return err(`没搜到「${keyword}」相关的视频，换个词试试`);
          picked = s2.items[Math.min(pickNo, s2.items.length) - 1];
          usedPage = 1;
          searchResult = s2;
          log(`「${keyword}」的可选视频都发过一轮了，重置后重新开始`);
        }

        const picked2 = picked;
        const sFinal = searchResult;

        // 下载并发出去（share 内部负责：单独发视频段、再单独发文案段）
        const r = await share({ link: picked2.url, ctx, replyToMessageId });
        if (!r.ok) {
          // 搜索命中但下载失败：如实回报，并把候选列表给模型，让它自己决定要不要换一条
          return err(`选中的《${picked2.title}》分享失败：${r.error}\n候选（已排除发过的）：`
            + sFinal.items.map((x, i) => `${i + 1}. ${x.title}（${x.author}，${x.playText}播放，${x.duration}）`).join('；'));
        }
        // 记账：把这个 BV 记进"该关键词已发过"，跨轮、跨重启都生效 —— 下次同词就不会再发它
        markSent(keyword, picked2.bvid, usedPage);
        ctx.biliCache.lastCall.set(cacheKey, Date.now() + COOLDOWN_MS);
        return ok({
          sent: true,
          picked: { title: picked2.title, author: picked2.author, url: picked2.url, play: picked2.play, playText: picked2.playText },
          ...(sFinal?.suggestion ? { searchedAs: sFinal.suggestion, note2: `你把词写成「${keyword}」，我按建议用「${sFinal.suggestion}」搜的。` } : {}),
          ...r,
          note: '视频已发出。下次同一个关键词会换一条没发过的；不要复述视频内容。'
        });
      } catch (error) {
        warn(`bili_video 执行异常：${error?.stack ?? error}`);
        return err(`分享出错：${error?.message ?? error}`);
      }
    }
  });
}

export const internals = { share, mediaDir, replyIdFromText, sentOf, markSent, resetSent, storeFile };
