/**
 * 配图模块：角色登场 / 使用技能时，配一张该角色的应景特写。
 *
 * 用户说"允许使用任何素材"。实际取图策略：
 *   ① 先看本地素材库（data/sukuna-raid/art/<角色>/）—— 用户自己丢进去的图优先
 *   ② 库里没有 → 用 tieba-sticker 已有的贴吧采集能力去对应吧取
 *   ③ 都取不到 → **不配图**，而不是拿一张不相干的图硬凑
 *
 * 为什么坚持"取不到就不配"：用户要的是"该角色的应景图特写"。
 * 随便配一张无关的图，比没有图更糟 —— 那是在骗人。
 *
 * ── 2026-10-03 改造：槽位化 + 章节偏好 + 三轮不重复 ────────────────
 *   · 文件名前缀 face__ / effect__ 就是槽位（见 lib/visual.js 注释）
 *   · 挑图时按"当前状态/招式的 keywords"给候选**打分**，取最高分
 *   · 记录最近用过的图，**3 轮内不重复**；第 4 轮起允许复用
 */
import fs from 'node:fs'
import path from 'node:path'

import { ART_SOURCES, SKILL_ART_HINT } from './data.js'
import { CHAPTERS, chapterForTurn, MOOD_SLOTS, SKILL_VISUAL, PLAYER_VISUAL } from './visual.js'

/**
 * 本地素材库目录。
 * @param {string} dataDir 应用 data 目录
 */
export function artDir(dataDir, character) {
  return path.join(dataDir, 'sukuna-raid', 'art', String(character || '通用'))
}

/** 列出某角色本地已有的素材（图片文件） */
export function listLocal(dataDir, character) {
  const d = artDir(dataDir, character)
  try {
    return fs.readdirSync(d)
      .filter((f) => /\.(png|jpe?g|gif|webp|bmp)$/i.test(f))
      .filter((f) => !f.startsWith('_'))          // _manifest.txt 之类
      .map((f) => path.join(d, f))
  } catch {
    return []
  }
}

/** 按技能提示词从本地素材里挑一张"应景"的。
 *
 * 文件名里含关键词的优先（用户可以把图命名成 宿傩_斩击.jpg 之类），
 * 没有命中就随机取一张 —— 同角色即可，不硬凑别的角色。 */
export function pickLocal(dataDir, character, skillId, rng = Math.random) {
  const all = listLocal(dataDir, character)
  if (!all.length) return null
  const hint = String(SKILL_ART_HINT[skillId] || '')
  const words = hint.split(/\s+/).filter(Boolean)
  if (words.length) {
    const hit = all.filter((f) => {
      const base = path.basename(f)
      return words.some((w) => base.includes(w))
    })
    if (hit.length) return hit[Math.floor(rng() * hit.length)]
  }
  return all[Math.floor(rng() * all.length)]
}

/* ── 槽位与打分 ─────────────────────────────────────────────────── */

/**
 * 从候选里挑最贴合 keywords 的一张。
 *
 * ══ 打分规则 ══════════════════════════════════════════════════════
 *   · **可信来源 + 精确关键词命中**  +24 × 命中数
 *   · 可信来源（`__官方_` / `__fandom_`）  +10
 *   · 槽位前缀命中                    +6
 *   · 章节 prefer 命中                +1
 *   · **贴吧等来源：关键词一律不算分**（见下）
 *   · 最近用过的                       跳过（recent 参数控制）
 *
 * ══ 什么算"可信来源" ══════════════════════════════════════════════
 *   只有文件名**自带语义**的源才算：
 *     · `__官方_伏魔御厨子.jpg`              —— 萌娘百科，文件名就是术式名
 *     · `effect__fandom_Malevolent_Shrine.jpg` —— Fandom，文件名是英文术式名
 *   贴吧图（`face__五条悟vs宿傩-百度贴吧__xx.jpg`）**不算** —— 文件名是帖子标题。
 *
 * ══ 为什么贴吧图的关键词要"一律不算分" ════════════════════════════
 *   这是实测出来的真故障，不是理论担忧。贴吧的标题长这样：
 *     `哎_这就是抖音_大残宿傩肘不过虎杖_所以等于原装__24b65179ac.jpg`
 *     `如果新宿决战宿傩受肉的是贝吉塔_100_受肉成功__c10ac1684a.jpg`
 *     `其实宿傩战胜乙骨_才是新宿战力最崩的一幕__64d5a56914.jpg`
 *
 *   这些标题里**天然含有大量招式名/角色名**（"宿傩""虎杖""乙骨""零/100"），
 *   于是关键词打分时它们疯狂命中 —— 虎杖 10 个招式里 6 个选中的是
 *   标题带"宿傩"的贴吧图，画面根本不是虎杖出招。
 *
 *   根因：**帖子标题是"话题"不是"画面内容"**。
 *   "标题里出现虎杖" ≠ "这张图是虎杖在打拳"。
 *   只要参与打分，它就一定会污染结果。所以直接排除在关键词打分之外，
 *   只在可信来源一张都没命中时，才作为兜底候选。
 *
 * ══ 为什么 +24 要高于来源加成 +10 ═════════════════════════════════
 *   反过来的坏行为也实测过：萌娘宿傩图只有 12 张，其中
 *   `坛荼印与宿傩领域展开手势对比.jpg` 含"宿傩 + 领域 + 展开"三个**通用词**，
 *   8 个招式里被选中 8 次 —— 用户看到的就是"永远发那张"。
 *   把"精确命中术式名"抬到 +24（高于来源 +10），
 *   才能让 `伏魔御厨子.jpg` / `Malevolent_Shrine.jpg` 这类
 *   **真的写了术式名**的图赢过"名字里恰好有通用词"的图。
 *
 * @param {string[]} files 候选绝对路径
 * @param {{slot?:string, keywords?:string[], prefer?:string[], recent?:string[]}} opt
 * @param {() => number} rng
 */

/** 来源可信度加成：文件名自带语义的源 */
function sourceBonus(base) {
  if (base.includes('__fandom_')) return 10
  if (base.includes('__官方_')) return 10
  return 0
}

/** 是否可信来源（文件名自带语义） */
function isTrusted(base) {
  return base.includes('__fandom_') || base.includes('__官方_')
}

/**
 * 是否是"纯章节编号"图（`Chapter_168.jpg`、`Chapter 231.jpg`）。
 *
 * ⚠️ 这类图**必须降权**。Fandom 的 Gallery 里混了大量按章节命名的漫画分格，
 *    文件名只有 `Chapter 168`，**完全不含画面信息**。
 *    实测：虎杖 10 个招式里有 6 个选中了 `Chapter NNN.jpg` ——
 *    因为"谁都命不中关键词"时它们和其他图同分，随机就抽到了。
 *    玩家看到的就是一堆没有意义的漫画页。
 *
 *    处理：给一个负分，让它们**只在真正没有语义图可选时**才被抽到。
 */
function isChapterOnly(base) {
  return /^chapter[\s_-]*\d+/i.test(base.replace(/^(face|effect)__(官方|fandom)_/, ''))
}

/**
 * 角色 → 别名列表（用于判断"这张图画的是不是这个角色"）。
 *
 * Fandom 用英文名，萌娘用中文名，所以两边都要列。
 * 兜底找肖像时靠这个匹配。
 */
export const CHARACTER_ALIAS = {
  两面宿傩: ['宿傩', 'Sukuna', 'Ryomen'],
  虎杖悠仁: ['虎杖', 'Yuji', 'Itadori'],
  伏黑惠: ['伏黑', 'Megumi', 'Fushiguro'],
  五条悟: ['五条', 'Gojo', 'Satoru'],
  禅院甚尔: ['甚尔', 'Toji'],
  乙骨忧太: ['乙骨', 'Yuta', 'Okkotsu'],
  漏瑚: ['漏瑚', 'Jogo'],
  七海建人: ['七海', 'Nanami'],
  东堂葵: ['东堂', 'Todo'],
  狗卷棘: ['狗卷', 'Inumaki'],
  里梅: ['里梅', 'Uraume'],
  羂索: ['羂索', 'Kenjaku'],
}

/**
 * 明确画的是**其他角色出招**的图 —— 兜底时要排除。
 *
 * 踩过的坑：虎杖库里有 `Mahito uses Black Flash`（真人的黑闪）。
 * 如果只按"含 Black Flash"匹配，会把真人的画面配给虎杖，属于**配错人**。
 * 所以这类"别人的技能"图要挡掉，除非文件名同时含本角色别名。
 */
export const OTHER_PROTAGONIST_RE = /Mahito|Gojo|Megumi|Nobara|Todo|Nanami|Jogo|Toji|Yuta|Kenjaku|Inumaki|Uraume|Maki|Kashimo|Hajime|Choso|Sukuna/i

export function scorePick(files, { slot = '', keywords = [], prefer = [], recent = [], subject = '' } = {}, rng = Math.random) {
  if (!files.length) return null
  const usable = files.filter((f) => !recent.includes(f))
  const pool = usable.length ? usable : files      // 全都用过 → 允许复用（三轮后复用）
  const scored = pool.map((f) => {
    const base = path.basename(f)
    const trusted = isTrusted(base)
    let score = 0

    // 关键词只在可信来源上算分 —— 贴吧标题是"话题"不是"画面"
    if (trusted) {
      let hits = 0
      for (const k of keywords) if (k && base.includes(k)) hits++
      if (hits > 0) score += 24 + (hits - 1) * 3
    }

    score += sourceBonus(base)
    // 槽位前缀：**必须是强约束**，不是微弱加分。
    //
    // ⚠️ 这里修过一个真实故障（2026-10-04）：
    //    原来只有 +6，而 MOOD_SLOTS 的关键词里含 `宿傩` 这种**几乎每张图都有**的词
    //    → 关键词给 +24，轻松压过槽位 +6。
    //    结果 `pickFace()` 会抽到 `effect__官方_坛荼印与宿傩领域展开手势对比.jpg`
    //    这种**效果图**当"表情图"，甚至抽到 `Aoi_Todo_saves_Hana_Kurusu`
    //    这种**画的是别的角色**的图。
    //    实测 12 次取脸图，混进了 2 张 effect__ 和 5 张别人出招的图。
    //
    // 现在分两级：
    //   · 槽位命中         → +40（高于任何一次关键词命中，确保"要脸图就给脸图"）
    //   · 槽位**不**命中   → −18（不是这个槽位的图明显降权，但不绝对排除 ——
    //                              该槽位一张都没有时还得有图可发）
    if (slot) {
      if (base.startsWith(slot + '__')) score += 40
      else score -= 18
    }
    for (const k of prefer) if (k && base.includes(k)) score += 1
    // 纯章节图降权：文件名无画面信息，只在没别的可选时才用
    if (isChapterOnly(base)) score -= 20

    // ── 主角归属（subject）────────────────────────────────────────────
    //
    // ⚠️ 又一个实测出来的真实故障（2026-10-04，用视觉确认）：
    //    Fandom 的 `Sukuna/Image Gallery` **不等于"宿傩出镜的图"** ——
    //    它收录的是"宿傩相关章节"的分格，里面大量是**别人在打**。
    //    实例：`face__fandom_Aoi_Todo_saves_Hana_Kurusu.jpg`
    //    名字说的是东堂救花，画面实际是**虎杖打出「黒閃」**（带振假名 こくせん）。
    //    这张被当成"宿傩的表情图"发出去，属于**配错人**。
    //
    // 判定：文件名里出现**其他角色**、且**不含本角色别名** → 重罚。
    // 用 −30 而非绝对排除：这类图仍然比"没有图"强，但应排在所有
    // 真·本角色图之后。若整池都是别人的图，那也只能用 —— 好过不发。
    if (subject) {
      const aliases = CHARACTER_ALIAS[subject] || [subject]
      const hasMe = aliases.some((a) => base.includes(a))
      if (OTHER_PROTAGONIST_RE.test(base) && !hasMe) score -= 30
    }
    return { f, score, trusted }
  })

  const max = Math.max(...scored.map((s) => s.score))
  // 同分里随机取一张 —— 保证"每次过回合不重样"
  const top = scored.filter((s) => s.score === max)
  return top[Math.floor(rng() * top.length)].f
}

/**
 * 按"状态 + 章节"取一张脸图。
 * @param {string} dataDir
 * @param {string} mood     MOOD_SLOTS 的 key
 * @param {number} turn     当前回合（决定章节）
 * @param {string[]} recent 最近用过的（3 轮内不重复）
 */
export function pickFace(dataDir, mood, turn = 0, recent = [], rng = Math.random) {
  const all = listLocal(dataDir, '两面宿傩')
  if (!all.length) return null
  const slotCfg = MOOD_SLOTS[mood] || MOOD_SLOTS.normal
  const ch = chapterForTurn(turn)
  return scorePick(all, {
    slot: 'face',
    keywords: slotCfg.keywords || [],
    prefer: ch.prefer || [],
    recent,
    subject: '两面宿傩',
  }, rng)
}

/**
 * 按"招式"取一张技能图（第②气泡）或效果图（第③气泡）。
 *
 * ── 命中失败时的兜底策略（关键）─────────────────────────────────
 *   问题：虎杖的图库结构特殊 —— `Yuji Itadori/Image Gallery` 里 119 张
 *   大多是"别人和虎杖互动"的画面（`Aoi Todo s fantasy memories with Yuji`、
 *   `Mahito hits Yuji with skewered humans`），**虎杖自己出招的图极少**。
 *   所以他的很多招式注定命不中关键词。
 *
 *   如果命不中就"随机"，会抽出 `Baseball Game`（棒球赛）、
 *   `Blood Meteorite`（别人中招）这种**完全不相关**的画面 —— 比配错更糟，
 *   因为它看起来像随机噪声。
 *
 *   所以兜底改成：**退回该角色自己的肖像图**（文件名含角色名的 trusted 图）。
 *   肖像至少保证"画的是这个角色"，用户看到的是主角本人而非路人。
 *
 * @param {'cast'|'effect'} kind
 */
export function pickSkillArt(dataDir, character, skillId, kind = 'cast', recent = [], rng = Math.random) {
  const all = listLocal(dataDir, character)
  if (!all.length) return null

  // ⚠️ 两种数据结构，取法不同 —— 这里踩过坑：
  //    · SKILL_VISUAL[skillId]  = { cast: {keywords,tip}, effect: {keywords,tip} }  ← 宿傩，分槽位
  //    · PLAYER_VISUAL[skillId] = { keywords, tip }                                 ← 玩家，**不分槽位**
  //    之前统一写成 `vis?.[kind] || vis?.cast` —— 对玩家而言两级都是 undefined，
  //    于是 cfg 变成 `{keywords: []}`，**关键词被整个丢掉**，
  //    所有玩家招式都命不中，全部掉到肖像兜底。
  //    这就是"逕庭拳明明有 Divergent_Fist.jpg 却永远不选"的根因。
  const vis = SKILL_VISUAL[skillId]
  const playerVis = PLAYER_VISUAL[skillId]
  const cfg = vis
    ? (vis[kind] || vis.cast || { keywords: [] })
    : (playerVis || { keywords: [] })

  // 第一步：按术式关键词正常打分
  const hit = scorePick(all, {
    slot: kind === 'effect' ? 'effect' : '',
    keywords: cfg.keywords || [],
    recent,
    subject: character,
  }, rng)

  // 第二步：判断是否真的"命中"了关键词 —— 而不是掉到兜底
  if (hit) {
    const base = path.basename(hit)
    const matched = (cfg.keywords || []).some((k) => k && base.includes(k))
    if (matched) return hit
  }

  // 第三步：没命中 → 退回角色肖像（保证画面里是这个角色）
  //
  // ⚠️ 肖像池不能只认"文件名含角色名" —— 那样虎杖只剩 1 张 `虎杖悠仁.jpg`，
  //    10 个招式全撞同一张，比随机还难看。
  //    放宽为：**trusted 来源 + 不是纯章节图 + 文件名里出现角色名或其英文罗马音**，
  //    并优先选 cast 槽（人物特写）。这样池子够大，且仍然保证是本人画面。
  const alias = CHARACTER_ALIAS[character] || [character]
  const portrait = all.filter((f) => {
    const b = path.basename(f)
    if (recent.includes(f)) return false
    if (!isTrusted(b)) return false          // 贴吧标题不算
    if (isChapterOnly(b)) return false       // 纯章节图不算
    // 画面主体可能是"某人和角色互动" —— 只要角色名出现就接受，
    // 但**必须排除明确画的是别的主角技能**的情况（如 Mahito uses Black Flash）
    if (OTHER_PROTAGONIST_RE.test(b) && !alias.some((a) => b.includes(a))) return false
    return true
  })
  if (portrait.length) {
    // ⚠️ 这里**不能**再走 scorePick —— `slot:'face'` 会把唯一那张
    //    `face__官方_Itadori_Yuji.png` 顶成最高分，兜底永远同一张。
    //    实测：12 次兜底调用只产出 1 张图。
    //    兜底的目的本来就是"随手给一张本人的图"，所以直接均匀随机。
    return portrait[Math.floor(rng() * portrait.length)]
  }

  return hit   // 连肖像都没有 → 用第一步的结果
}

/**
 * 取一张图：本地优先；本地没有时**由调用方决定**是否去贴吧抓
 * （抓取很慢，交给工具层显式触发，不在这里偷偷做网络请求）。
 *
 * @returns {{ file?: string, forum?: string, needFetch?: boolean, reason?: string }}
 */
export function resolveArt(dataDir, character, skillId, rng = Math.random) {
  const local = pickLocal(dataDir, character, skillId, rng)
  if (local) return { file: local }

  const src = ART_SOURCES[character] || null
  return {
    needFetch: true,
    forum: src?.forum || String(character || ''),
    fallbackForum: src?.fallbackForum || '',
    reason: `本地没有「${character}」的素材，需要去贴吧取。`,
  }
}

/** 把一张图登记进本地素材库 */
export function addArt(dataDir, character, srcFile, nameHint = '') {
  const d = artDir(dataDir, character)
  fs.mkdirSync(d, { recursive: true })
  const ext = path.extname(srcFile) || '.jpg'
  const base = (nameHint || path.basename(srcFile, ext)).replace(/[^\w\u4e00-\u9fa5-]/g, '_').slice(0, 40)
  let dest = path.join(d, `${base}${ext}`)
  let n = 1
  while (fs.existsSync(dest)) dest = path.join(d, `${base}_${n++}${ext}`)
  fs.copyFileSync(srcFile, dest)
  return dest
}

/** 素材库概况（给 status 工具用） */
export function artSummary(dataDir, characters = []) {
  const out = {}
  for (const c of characters) {
    const n = listLocal(dataDir, c).length
    if (n) out[c] = n
  }
  return out
}

/** 素材库槽位统计（给 status / art 工具用，方便自查采集质量） */
export function slotStats(dataDir, character) {
  const all = listLocal(dataDir, character).map((f) => path.basename(f))
  const s = { total: all.length, face: 0, effect: 0, other: 0 }
  for (const f of all) {
    if (f.startsWith('face__')) s.face++
    else if (f.startsWith('effect__')) s.effect++
    else s.other++
  }
  return s
}

export const internals = {
  artDir, listLocal, pickLocal, resolveArt, addArt, artSummary,
  scorePick, pickFace, pickSkillArt, slotStats,
}
