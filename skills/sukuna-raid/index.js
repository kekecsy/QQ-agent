/**
 * 宿傩讨伐战 —— 主入口。
 *
 * 玩法（用户设定）：
 *   · 群里所有人 @ 机器人即可上场打宿傩，**宿傩状态不重置，沿用上一个人的战绩**
 *   · 玩家扮演咒术师，可「防御 / 攻击 / 反转术式」
 *   · 攻击打出黑闪 → **该玩家个人数据**进化为虎杖悠仁（每人分开算）
 *   · 所有伤害都是百分比；只有黑闪能造成 5% 伤害并**中断反转术式 3 回合**
 *   · 宿傩 100% 血 + 高额回复，单个咒术师只有他 20% 实力，虎杖 30%
 *   · 一个咒术师战死 → 播报「连一刻也没有为XXX而哀悼，下一个奔赴战场的是！」
 *   · **纯文字对战**（2026-10-04 起）：战报文字直接发进群，不配任何图
 *
 * 关于配图（已移除，不要再加回来）：
 *   曾经有过三气泡配图（①宿傩状态图 ②技能图 ③效果图），素材来自贴吧/Fandom/Pixiv。
 *   实测三条路都不可靠：
 *     · 贴吧 —— `tiebapic.baidu.com` 对程序化请求一律返回 4262B/238x238 的占位图
 *     · Fandom —— `Sukuna/Image Gallery` 收录的是"相关章节分格"，
 *                 大量画面里根本是**别人在打**（如 `Aoi_Todo_saves_Hana_Kurusu`
 *                 实际画的是虎杖打出黑闪）
 *     · Pixiv —— 必须挂代理，且标签蹭图严重、大图容易被截断
 *   用户决定去掉配图，只保留文字。
 *
 * 会话级 vs 玩家级（关键设计）：
 *   会话级（battle.json）：宿傩血量、反转术式状态、回合数、阵亡名单、当前出战者
 *   玩家级（players.json）：每人的血量、是否已进化、黑闪次数、保底计数
 *   用户明确说"宿傩的状态并不会重置，沿用上一个人的战绩"，所以两者必须分开存。
 */
import fs from 'node:fs'
import path from 'node:path'

import {
  ACTIONS, BLACK_FLASH, EVOLUTION, EVOLUTION_CHOICE, FLAGS,
  MAHORAGA, MAHORAGA_SUMMON, NARRATION,
  PLAYER_BASE, SUKUNA, SUKUNA_POWER, SUKUNA_TRUE_FORM,
  OPTION_COUNT,
} from './lib/data.js'
import {
  applyBossDamage, bar, bossStatus,
  canJoin, createMahoraga, damageTypeOf, enqueue, handleDeath,
  looksLikeBranchName,
  mahoragaStatus, mahoragaTakeHit, mahoragaTurn,
  maybeTransform, newBattle, newPlayer,
  playerStatus, playerTurn, queuePosition, resolveEvolution,
  reviveForNewGame,
  sukunaVsMahoraga, sukuNaTurn,
  renderOptions, rollOptions, skillToAction,
} from './lib/rules.js'
import {
  HP_BAR, MOOD_SLOTS, PLAYER_VISUAL, SKILL_VISUAL, chapterForTurn, pickLine,
} from './lib/visual.js'
import { DATA_DIR } from '../../src/config.js'

const ID = 'sukuna-raid'

let api = null
let log = () => {}
let cfgOf = () => ({})

/* ── 存档 ───────────────────────────────────────────────────────── */

function storeDir() {
  const c = cfgOf()
  const custom = String(c?.dataDir || '').trim()
  return custom || path.join(DATA_DIR, ID)
}
function battleFile(chatKey) {
  const safe = String(chatKey).replace(/[^\w-]/g, '_').slice(0, 80)
  return path.join(storeDir(), 'battle', `${safe}.json`)
}
function playersFile() {
  return path.join(storeDir(), 'players.json')
}

function readJson(f, dflt) {
  try {
    return JSON.parse(fs.readFileSync(f, 'utf8'))
  } catch {
    return dflt
  }
}
function writeJson(f, obj) {
  try {
    fs.mkdirSync(path.dirname(f), { recursive: true })
    fs.writeFileSync(f, JSON.stringify(obj, null, 1), 'utf8')
    return true
  } catch (e) {
    log(`存档写入失败：${String(e?.message || e).slice(0, 80)}`)
    return false
  }
}

/** 取（或建）本会话的战场。宿傩状态跨玩家沿用。 */
export function getBattle(chatKey) {
  const f = battleFile(chatKey)
  const b = readJson(f, null)
  if (b && b.boss) {
    // 兼容老存档：补上新字段
    b.boss.lastSkills = b.boss.lastSkills || []
    b.casualties = b.casualties || []
    b.log = b.log || []
    return b
  }
  const nb = newBattle()
  writeJson(f, nb)
  return nb
}
export function saveBattle(chatKey, b) {
  // 日志只留最近 N 条，避免存档无限膨胀
  const maxLog = Math.max(5, Number(cfgOf()?.logKeep) || 40)
  if (b.log.length > maxLog) b.log = b.log.slice(-maxLog)
  return writeJson(battleFile(chatKey), b)
}

/** 玩家是**全局**存的（同一个人在不同群也是同一个人），键用 userId */
export function getPlayer(userId, name) {
  const all = readJson(playersFile(), {})
  const p = all[String(userId)]
  if (p) {
    if (name && p.name !== name) p.name = name
    return p
  }
  return newPlayer(userId, name)
}
export function savePlayer(p) {
  const all = readJson(playersFile(), {})
  all[String(p.id)] = p
  return writeJson(playersFile(), all)
}

/* ── 上下文取值 ─────────────────────────────────────────────────── */

/** 从 ctx 里取玩家 id / 名字。取不到就用会话兜底，保证不崩。 */
function whoIs(ctx) {
  const entries = triggerEntriesOf(ctx)
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i]
    if (e && e.self === true) continue          // 跳过机器人自己
    if (e && (e.senderId || e.senderName)) {
      return { id: String(e.senderId || e.senderName), name: String(e.senderName || e.senderId) }
    }
  }
  return { id: 'unknown', name: '无名咒术师' }
}

/* ── 激活词 ────────────────────────────────────────────────────────
 *
 * 用户要求："添加激活词：宿傩/BOSS"。
 *
 * 为什么需要它：光靠"被 @"唤醒还不够 —— 群里聊漫画、聊剧情时也会 @ 到机器人，
 * 那时不该开局。激活词的作用是**判断他们在聊 BOSS 战**。
 *
 * 默认词表：宿傩 / 宿滩 / BOSS / 讨伐 / 打boss。其中"宿滩"是常见错字，
 * 一并认掉；大小写不敏感（BOSS/boss/Boss 都算）。
 */
/* ── 触发信息缓存 ───────────────────────────────────────────────────
 *
 * ⚠️ 这是修一个**真实故障**：工具的 ctx 里没有 triggerEntries！
 *
 * orchestrator 传给工具的 ctx 只有 chatKey/kind/store/sender/session/…，
 * **不含**本轮触发的消息。只有 before-context / before-tool 这类钩子拿得到。
 * 结果就是：消息里明明 atMe=true（存档可查），工具里却判定"没被@"，
 * 表现为"@我了，但工具说你没真@上"。
 *
 * 所以必须：钩子里捕获 → 按 sessionId 暂存 → 工具里取用。
 * 这个做法与 jm-comic / group-admin 一致，是项目里的成熟模式。
 */
const triggerCache = new Map()   // sessionId -> { entries, at }

function rememberTriggers(ctx = {}) {
  try {
    const sid = String(ctx?.sessionId ?? ctx?.session?.id ?? '')
    const entries = Array.isArray(ctx?.triggerEntries) ? ctx.triggerEntries : null
    if (!sid || !entries || !entries.length) return
    triggerCache.set(sid, { entries, at: Date.now() })
    // 防泄漏：只留最近 40 个会话
    if (triggerCache.size > 40) {
      const keys = [...triggerCache.keys()].slice(0, triggerCache.size - 40)
      for (const k of keys) triggerCache.delete(k)
    }
  } catch { /* 缓存失败不影响主流程 */ }
}

/** 取得本轮触发的消息：先看 ctx 自带，再查缓存 */
function triggerEntriesOf(ctx = {}) {
  if (Array.isArray(ctx?.triggerEntries) && ctx.triggerEntries.length) return ctx.triggerEntries
  const sid = String(ctx?.sessionId ?? ctx?.session?.id ?? '')
  const hit = sid ? triggerCache.get(sid) : null
  if (hit?.entries?.length) return hit.entries
  // 最后兜底：从 store 的未读里取（工具执行时这批通常还没标已读）
  try {
    const st = ctx?.store
    if (st && typeof st.peekUnread === 'function' && ctx?.chatKey) {
      const u = st.peekUnread(ctx.chatKey, 6)
      if (Array.isArray(u) && u.length) return u
    }
  } catch { /* 兜底失败就返回空 */ }
  return []
}

const DEFAULT_ACTIVATION = ['宿傩', '宿滩', 'BOSS', '讨伐']

function activationWords() {
  const raw = String(cfgOf()?.activationWords ?? '').trim()
  if (!raw) return DEFAULT_ACTIVATION
  const list = raw.split(/[,，\s]+/).map((x) => x.trim()).filter(Boolean)
  return list.length ? list : DEFAULT_ACTIVATION
}

/** 消息里是否命中激活词 */
function hitActivation(ctx) {
  const entries = triggerEntriesOf(ctx)
  const text = entries.filter((e) => e?.self !== true).map((e) => String(e?.text || '')).join('\n')
  if (!text) return false
  const low = text.toLowerCase()
  return activationWords().some((w) => low.includes(String(w).toLowerCase()))
}

/** 群友是否明确表示"要开打"（而不是只在聊剧情） */
const CONFIRM_RE = /(我要打|我打|开打|开始打|开局|开一局|开个局|开战|来一局|来一把|上号|上吧|来吧|打宿傩|打boss|打boss战|走起|干他|打他|开)/i
function wantsStart(ctx) {
  const entries = triggerEntriesOf(ctx)
  const text = entries.filter((e) => e?.self !== true).map((e) => String(e?.text || '')).join(' ')
  return CONFIRM_RE.test(text)
}

/** 只有被 @ 才能上场（与 tieba-sticker 同一套判定，保持一致） */
function isMentioned(ctx) {
  const entries = triggerEntriesOf(ctx)
  if (entries.some((e) => e?.atMe === true)) return true
  // ⚠️ atMe 是**权威字段**（app.js 里有 @ 段时以 QQ 号为准判定）。
  //    如果它明确是 false，就不能再用下面的文本兜底把结论翻回来 ——
  //    否则消息文本里只要出现「@机器人名」这种字面量（转述、引用、复读）
  //    就会被误判成"被 @"。实测踩过这个坑。
  if (entries.length && entries.every((e) => e?.atMe === false)) {
    return String(ctx?.kind || '') === 'private'
  }
  const names = ['沙耶哦']
  if (ctx?.botName) names.push(String(ctx.botName))
  if (ctx?.selfNickname) names.push(String(ctx.selfNickname))
  const text = entries.map((e) => String(e?.text || '')).join(' ')
  if (names.some((n) => n && text.includes('@' + n))) return true
  return String(ctx?.kind || '') === 'private'
}

function replyTarget(ctx) {
  const entries = triggerEntriesOf(ctx)
  for (let i = entries.length - 1; i >= 0; i--) if (entries[i]?.mid) return entries[i].mid
  return null
}

/** 把"已发消息"记进会话，避免模型在图/战报之后再补一段废话 */
function recordSent(ctx, text) {
  try {
    ctx?.session?.sent?.push({
      type: 'text',
      text: text || '[战报]',
      at: new Date().toLocaleTimeString('zh-CN', { hour12: false }),
    })
    ctx?.emit?.('session-update', ctx?.session?.id)
  } catch (e) {
    log(`记发送失败：${String(e?.message || e).slice(0, 60)}`)
  }
}

/* ── 直接发文本（修"只发图没文字"的关键）───────────────────────────
 *
 * ⚠️ 为什么必须由技能自己发，而不是把文字当 content 返回给模型：
 *
 *   工具返回的 content 是喂给**模型**的，不是发到群里的。
 *   模型看到之后可能：
 *     · 觉得没必要复述 → 群里只剩一张图（用户实际遇到的就是这个）
 *     · 自己概括一句"就这？连皮都没蹭掉" → 战报全丢了
 *   实测用户群里就是后者：一条 [图片:宿傩] + 一句废话。
 *
 *   战报是**确定性输出**，不该交给模型转述 —— 必须自己发。
 *   发完再 push 进 session.sent，让 orchestrator 知道"这一轮已经说过话了"，
 *   模型就不会再补一段。
 */
async function sendText(ctx, text, { reply = true } = {}) {
  const t = String(text || '').trim()
  if (!t) return false
  const sender = ctx?.sender
  if (!sender || typeof sender.sendTextBatch !== 'function') {
    // 没有发送通道：退回"记一笔"，至少不让模型重复说
    recordSent(ctx, t)
    return false
  }
  try {
    const r = await sender.sendTextBatch(ctx.chatKey, [t], reply ? {
      replyToMessageId: replyTarget(ctx),
    } : {})
    const sentList = Array.isArray(r?.sent) ? r.sent : []
    for (const item of sentList) {
      ctx?.session?.sent?.push({
        type: 'text',
        text: item?.text || t,
        at: new Date().toLocaleTimeString('zh-CN', { hour12: false }),
      })
    }
    if (!sentList.length) recordSent(ctx, t)
    ctx?.emit?.('session-update', ctx?.session?.id)
    return true
  } catch (e) {
    log(`战报发送失败：${String(e?.message || e).slice(0, 80)}`)
    recordSent(ctx, t)
    return false
  }
}

/* ── BOSS 登场演出 ────────────────────────────────────────────────
 *
 * 用户澄清："宿傩不是群里的人，是由机器人发出的文字boss，配图进行挑战"。
 * 所以他不需要是群成员、也不需要被 @ —— 机器人把他"演"出来即可。
 * 这里给他一段登场宣告 + BOSS 台词，再配特写图。
 */
function bossBanner() {
  // ⚠️ 第二行原来写死"领域展开·伏魔御厨子"，但开局他还没开领域 ——
  //    那行会跟后面章节系统讲的剧情打架（第一章还是"受肉"）。
  //    改成中性的形态描述，把"领域展开"留给真正的领域章节。
  return [
    '╔══════════════════════════════╗',
    '║   👹  两面宿傩  ·  诅咒之王  ║',
    '║      受肉之躯 · 四手四眼      ║',
    '╚══════════════════════════════╝',
  ].join('\n')
}

/**
 * BOSS 登场台词。
 *
 * 用户要求"贴上一段原著台词"。这些取自《咒术回战》原著里宿傩的语气与名场面
 * （萌娘百科台词页 + 动画字幕记忆），**不是逐字校对过的台本** ——
 * 手边只有萌娘百科的能力段与台词摘录，没有完整台本可核。
 * 所以这里是"原著向"，接近原句但可能有措辞差异，不当成逐字引用。
 */
const OPENING_LINES = [
  '「尽情回味吧，臭小子。」',
  '「你以为你在跟谁说话？」',
  '「千年前我也站在这里，也杀光了所有人。」',
  '「来吧 —— 让我看看你们能撑几回合。」',
  '「不解风情……那就一起变成碎块吧。」',
  '「无聊。你们的术式，我看一眼就够了。」',
]
function pickOpening() {
  return OPENING_LINES[Math.floor(Math.random() * OPENING_LINES.length)]
}

/* ── 战报拼装 ───────────────────────────────────────────────────── */

function bb() { return '─'.repeat(26) }

function bossLine(b) {
  const boss = b.boss
  const pct = boss.hp.toFixed(1)
  const flags = []
  if (boss.interruptLeft > 0) flags.push(`${FLAGS.interrupted}(剩${boss.interruptLeft})`)
  else if (boss.reversed) flags.push(FLAGS.reversed)
  // 真身：名字要跟着变，否则群里看到的还是"两面宿傩"，
  // 玩家不知道他已经是四手形态了（形态是战斗信息，不是装饰）
  if (boss.trueForm) flags.push(`👹 ${SUKUNA_TRUE_FORM.formName}`)
  if (boss.stunned > 0) flags.push(`💫 眩晕${boss.stunned}`)
  const nm = boss.trueForm ? SUKUNA_TRUE_FORM.name : boss.name
  return `${nm}　${bar(boss.hp, boss.maxHp, 'boss')} ${pct}%` + (flags.length ? `　${flags.join(' ')}` : '')
}
function playerLine(p) {
  return `${p.name}${p.evolved ? ` ${FLAGS.evolved}` : ''}　${bar(p.hp, p.maxHp, 'player')} ${p.hp.toFixed(1)}/${p.maxHp}`
}

/* ── 核心：一个回合 ─────────────────────────────────────────────── */

/**
 * 结算一个回合。
 *
 * 流程（顺序不能乱，每一段都有理由）：
 *   ① 转职选择拦截 —— 有 pending 的 evolveChoice 时，输入是"选路"不是"出招"
 *   ② 排队检查 —— 不是本人的回合就只入队
 *   ③ 解析选项
 *   ④ 玩家行动（或操控魔虚罗行动）
 *   ⑤ 真身变身判定（多人时 30%）
 *   ⑥ 宿傩行动
 *   ⑦ 魔虚罗降伏脚本
 *   ⑧ 死伤 / 胜负
 *   ⑨ 组装战报（含旁白）
 */
async function takeTurn(ctx, choiceArg, { autoSend = true } = {}) {
  const cfg = cfgOf()
  const chatKey = ctx?.chatKey
  if (!chatKey) return { ok: false, error: '拿不到会话标识。' }

  const who = whoIs(ctx)
  const b = getBattle(chatKey)

  const p0 = getPlayer(who.id, who.name)

  // ── ⓪ 转职选择的卫生检查 ──
  //
  // 两个真实会发生的坏情况，不处理就会卡死战局：
  //   ① 挂起选择的人**在同回合被打死**（黑闪后宿傩反手秒掉他）——
  //      选择永远等不到人回，后面所有人都被这个悬空的 pending 挡住。
  //   ② 玩家干脆不回（打完黑闪就去干别的了）——
  //      战报会一直显示"请回复 1 或 2"，占着位置没法继续打。
  // 兜底：持有者已死 → 直接清掉；超时 → 自动按第 1 项（虎杖）结算。
  if (b.evolveChoice) {
    const owner = getPlayer(b.evolveChoice.id, b.evolveChoice.name)
    if (!owner || !owner.alive || owner.hp <= 0) {
      b.evolveChoice = null
      saveBattle(chatKey, b)
    } else if (b.turn - Number(b.evolveChoice.turn || b.turn) >= EVOLUTION_CHOICE.autoAfterTurns
      && b.evolveChoice.id !== who.id) {
      // 别人开口了 → 帮超时的玩家自动走虎杖，别让全群陪等
      const auto = resolveEvolution(b, owner, 1)
      if (auto.ok) {
        savePlayer(owner)
        b.evolveChoice = null
        saveBattle(chatKey, b)
        log(`${owner.name} 的转职超时，自动选了虎杖悠仁`)
      }
    }
  }

  // ── ① 转职选择拦截 ──
  //
  // ⚠️ 只在**回复的是分支名**时拦截（「虎杖」/「伏黑」）。
  //    绝不能用数字拦截 —— 数字是出招用的，撞号会导致
  //    "想打第 1 招却被当成选了虎杖"（这个 bug 真的发生过，见
  //    rules.js 里 looksLikeBranchName 的注释）。
  //    没选转职时就正常出招，转职挂起继续等着，两件事互不阻塞。
  if (b.evolveChoice && b.evolveChoice.id === who.id && looksLikeBranchName(choiceArg)) {
    return await resolveEvolutionTurn(ctx, b, p0, choiceArg, { autoSend })
  }

  // ── ② 排队检查（用户要求"多人同时参战进入排队制"）──
  const qres = enqueue(b, p0)
  saveBattle(chatKey, b)
  if (!qres.isFighting) {
    const text = [
      `【排队中】${p0.name}，你前面还有 **${qres.ahead}** 人。`,
      b.fighterName ? `现在在场上的是 ${b.fighterName} —— 他倒下就轮到你。` : '',
      `队列：${b.queue.map((x, i) => `${i + 1}. ${x.name}`).join(' → ')}`,
      b.boss.trueForm ? '⚠️ 他已经变了真身，撑住。' : '',
    ].filter(Boolean).join('\n')
    if (autoSend) await sendText(ctx, text)
    return {
      ok: true, queued: true, text, position: qres.position,
      hint: `${p0.name}在排队（第 ${qres.position + 1} 位）。不要复述这段内容。`,
    }
  }

  const p = qres.already ? p0 : p0

  // ⚠️ **全新一局的第一回合**：把玩家复原再上场。
  //
  //    为什么放在这里：players.json 是**全局**的（同一个人在别的群也是他），
  //    所以上个群打剩的 3 点血、或者上个群里的 `alive:false`，
  //    都会原样带进这个新群。症状是"一开局就被秒"，
  //    看起来像数值崩了，其实是没清局内状态。
  //    转职保留（那是跨局的个人进度），血量与生死按新局重置。
  if (b.turn === 0 && !b.evolveChoice) {
    reviveForNewGame(p)
    savePlayer(p)
  }

  let died = false
  let victoria = false
  const acts = []
  const narration = []          // 旁白素材，最后统一渲染

  if (b.boss.hp <= 0) {
    return {
      ok: false,
      error: `${SUKUNA.name}已被讨伐（${b.casualties.length} 人阵亡）。`
        + '想重开的话说一声"重开一局"，我会把他的血量和状态重置。',
    }
  }

  const join = canJoin(b, p)
  if (!join.ok) return { ok: false, error: join.reason, dead: !!join.dead }

  b.turn += 1

  // ── ③ 解析选项 ──
  let bossSkillUsed = null
  const pending = Array.isArray(b.pending) ? b.pending : []
  const chosen = resolveChoice(choiceArg, pending, b)
  let action = skillToAction(chosen)

  const nameTag = p.branch === 'yuji' ? '（虎杖悠仁）'
    : (p.branch === 'megumi' ? '（伏黑惠）' : '')
  acts.push(`【第 ${b.turn} 回合】${p.name}${nameTag} 出战`)
  if (chosen) acts.push(`${p.name}使出 ${chosen.icon}【${chosen.name}】`)

  let pr = { events: [], blackFlash: false, dmg: 0, evolved: false, died: false }
  let mahoAct = null

  // ── ④ 玩家行动 ──
  if (action === 'summon') {
    // 召唤魔虚罗：吟唱一回合
    p.summoning = true
    p.mahoragaUsed = true
    b.mahoragaCast = { id: p.id, name: p.name, sinceTurn: b.turn }
    acts.push(`　${p.name}双手前伸，念出布瑠真言 ——`)
    acts.push(`　${MAHORAGA.chant}`)
    acts.push(`　空气从裂缝里挤出来。影子开始变形。`)
    narration.push(pickLine(NARRATION.mahoragaAppear, b.turn))
  } else if (p.controllingMahoraga && b.mahoraga) {
    // 操控魔虚罗：玩家出的招由魔虚罗执行
    mahoAct = mahoragaTurn(b.mahoraga, chosen?.id, Math.random)
    acts.push(`　（${p.name}的视角已经不属于自己 —— 他现在**操控着魔虚罗**。）`)
    acts.push(...mahoAct.events)
    if (mahoAct.dmg > 0) {
      b.boss.hp = Math.max(0, b.boss.hp - mahoAct.dmg)
      acts.push(`　→ 命中${b.boss.name}，造成 ${mahoAct.dmg.toFixed(1)}% 伤害。`)
    }
    pr.blackFlash = false
  } else {
    pr = playerTurn(b, p, action, { skill: chosen }, Math.random)
    acts.push(...pr.events)
    if (pr.blackFlash) narration.push(pickLine(NARRATION.blackFlash, b.turn))
  }

  // ── ④b 魔虚罗出场（吟唱完成）──
  if (b.mahoragaCast && !b.mahoraga && p.hp > 0) {
    const m = createMahoraga(b.mahoragaCast.id, b.mahoragaCast.name)
    b.mahoraga = m
    b.mahoragaCast = null
    acts.push(`　【异戒神将·魔虚罗】登场 —— 法轮开始转动。`)
    acts.push(`　${MAHORAGA.lines.appear}`)
    // 出场先咬召唤者一口（原著：召唤者即为第一目标）
    const bite = MAHORAGA.openingBite
    p.hp = Math.max(0, p.hp - bite)
    acts.push(`　它第一个攻击的**不是宿傩** —— 它扑向了召唤者 ${p.name}。`)
    acts.push(`　→ ${p.name}受到 ${bite}% 伤害（现 ${p.hp.toFixed(1)}/${p.maxHp}）。`)
    if (p.hp <= 0) {
      acts.push(`　召唤者倒下 —— 魔虚罗失去锚点，开始消散。`)
      b.mahoraga = null
      p.controllingMahoraga = false
    } else {
      // 召唤者活下来 → 视角切换到魔虚罗
      p.controllingMahoraga = true
      acts.push(`　${p.name}撑住了。咒力的指挥权，转到了那只东西身上。`)
    }
  }

  // ── ⑤ 真身变身判定（多人时 30%）──
  if (p.hp > 0 && b.boss.hp > 0) {
    const tf = maybeTransform(b, Math.random)
    if (tf.transformed) {
      acts.push(...tf.events)
      narration.push(pickLine(NARRATION.trueForm, b.turn))
    }
  }

  // ── ⑥ 宿傩回合 ──
  let savedMahoraga = false
  if (p.hp > 0 && b.boss.hp > 0) {
    const sr = sukuNaTurn(b, Math.random)
    bossSkillUsed = sr.skill?.id || b.boss.lastSkillId || null
    acts.push(...sr.events)

    if (sr.stunned) {
      savedMahoraga = true
    } else if (b.mahoraga && b.mahoraga.phase !== 'destroyed' && b.mahoraga.phase !== 'active') {
      // 宿傩进入降伏阶段后，火力转向魔虚罗（不再打玩家）
      const type = damageTypeOf(sr.skill)
      const hit = mahoragaTakeHit(b.mahoraga, type, sr.dmg)
      acts.push(`　→ 但这一击是冲着**魔虚罗**去的。`)
      acts.push(...hit.events)
      acts.push(`　魔虚罗 ${b.mahoraga.hp.toFixed(1)}/${b.mahoraga.maxHp}`)
    } else if (b.mahoraga && b.mahoraga.phase === 'active') {
      // 还没看穿它 —— 分一部分火力，玩家压力减轻
      const half = sr.dmg * 0.5
      const applied = applyBossDamage(p, sr.skill, half)
      acts.push(`　→ 他分了一半注意力给那只式神。`)
      acts.push(`　→ ${p.name}受到 ${applied.dmg.toFixed(1)}% 伤害${applied.notes.join('')}`)
      const type = damageTypeOf(sr.skill)
      const hit = mahoragaTakeHit(b.mahoraga, type, sr.dmg * 0.5)
      acts.push(...hit.events)
    } else {
      const applied = applyBossDamage(p, sr.skill, sr.dmg)
      acts.push(`　→ ${p.name}受到 ${applied.dmg.toFixed(1)}% 伤害${applied.notes.join('')}`)
    }
  }

  // ── ⑦ 魔虚罗降伏脚本 ──
  let mahoragaDestroyed = false
  if (b.mahoraga && b.mahoraga.phase !== 'destroyed' && b.boss.hp > 0 && p.hp > 0) {
    const script = sukunaVsMahoraga(b, b.mahoraga, savedMahoraga || pr.blackFlash, Math.random)
    acts.push(...script.events)
    if (script.destroyed) {
      mahoragaDestroyed = true
      acts.push(`　${p.name}的战场视野回到了自己身上。`)
      p.controllingMahoraga = false
      b.mahoraga = null
    }
  }

  // ── ⑧ 计时递减 ──
  if (b.boss.interruptLeft > 0) b.boss.interruptLeft -= 1
  if (b.boss.domainCooldown > 0) b.boss.domainCooldown -= 1

  // ── ⑨ 阵亡判定 ──
  let broadcast = ''
  let nextFighter = null
  if (p.hp <= 0) {
    died = true
    const d = handleDeath(b, p)
    broadcast = d.broadcast
    nextFighter = d.next
    acts.push(`【阵亡】${p.name} 倒下。`)
    if (p.controllingMahoraga) {
      p.controllingMahoraga = false
      b.mahoraga = null
      acts.push(`　魔虚罗失去召唤者，随之消散。`)
    }
    narration.push(NARRATION.death(p.name))
    narration.push(`${SUKUNA.name}：${NARRATION.bossOnDeath}`)
  }

  // ── ⑩ 讨伐成功？ ──
  let victory = false
  if (b.boss.hp <= 0) {
    victory = true
    p.kills += 1
    acts.push(`${bb()}`)
    acts.push(`【讨伐成功】${SUKUNA.name}的领域消散了 —— 诅咒之王倒下了。`)
    acts.push(`最后一击由 ${p.name}${nameTag} 打出，全队阵亡 ${b.casualties.length} 人。`)
    narration.push(pickLine(NARRATION.victory, b.turn))
  }

  if (p.hp > 0 && p.hp / p.maxHp < 0.25) narration.push(pickLine(NARRATION.lowHp, b.turn))
  if (b.boss.lastSkillId === 'domain') narration.push(pickLine(NARRATION.domain, b.turn))

  b.log.push({ turn: b.turn, who: p.name, action, bf: pr.blackFlash, bossHp: b.boss.hp, died, at: Date.now() })
  savePlayer(p)
  saveBattle(chatKey, b)

  // ── ⑪ 摆出下一回合的选项 ──
  let opts = []
  if (!died && !victory && b.boss.hp > 0) {
    opts = rollOptions(p, OPTION_COUNT, Math.random)
    b.pending = opts
  } else {
    b.pending = []
  }
  saveBattle(chatKey, b)

  // ── ⑫ 组装战报（含旁白）──
  const report = buildReport(b, p, {
    acts, died, victory, opts, narration,
    bossSkill: bossSkillUsed, playerSkill: chosen, chapter: chapterForTurn(b.turn),
    mahoragaAct: mahoAct, mahoragaDestroyed,
  })

  const sentKinds = []
  let textSent = false
  if (autoSend && report?.text) {
    if (await sendText(ctx, report.text)) {
      textSent = true
      sentKinds.push(report.kind)
    }
  }

  const text = report?.text || ''
  const nextHint = died
    ? (nextFighter
      ? `他倒下了 —— ${nextFighter.name} 已经顶上（排队制）。`
      : '他倒下了。下一个人 @ 我就能接着上 —— 宿傩不会回血重置，战绩沿用。')
    : (victory ? '讨伐完成。' : '')

  return {
    ok: true, text, died, victory, blackFlash: pr.blackFlash,
    textSent, opts, report: sentKinds,
    chapter: chapterForTurn(b.turn).name,
    bossHp: b.boss.hp, playerHp: p.hp,
    trueForm: b.boss.trueForm, mahoraga: !!b.mahoraga,
    evolveChoice: b.evolveChoice ? true : false,
    queue: b.queue.map((x) => x.name),
    hint: nextHint,
  }
}

/**
 * 转职回合：玩家回复 1/2 选路。
 *
 * 单独拆出来的原因：这条路径**不推进回合、不让宿傩出手** ——
 * 转职是奖励，不该让玩家因为"多花一回合选路"而白挨打。
 */
async function resolveEvolutionTurn(ctx, b, p, arg, { autoSend = true } = {}) {
  const r = resolveEvolution(b, p, arg)
  const chatKey = ctx?.chatKey
  if (!r.ok) {
    if (autoSend) await sendText(ctx, r.error)
    return { ok: false, error: r.error }
  }
  savePlayer(p)

  // 转职后立刻按新身份摆选项
  const opts = rollOptions(p, OPTION_COUNT, Math.random)
  b.pending = opts
  saveBattle(chatKey, b)

  const lines = []
  lines.push(`${bar(b.boss.hp, b.boss.maxHp, 'boss')} ${SUKUNA.name} ${b.boss.hp.toFixed(1)}%`)
  lines.push('──────────────────────────')
  lines.push(...r.events)
  lines.push('──────────────────────────')
  lines.push(`${playerLine(p)}`)
  lines.push('')
  lines.push('【选择你的行动】')
  lines.push(renderOptions(opts))
  lines.push('')
  lines.push(choiceHint())

  const text = lines.join('\n')
  if (autoSend) await sendText(ctx, text)
  saveBattle(chatKey, b)

  return {
    ok: true, text, textSent: true, evoled: true,
    branch: r.branch?.key, opts,
    hint: `转职完成：${r.branch?.name}。不要复述战报。`,
  }
}

/* ── 战报文本的组装（纯文字，不含配图）───────────────────────────── */

/**
 * 组装本轮要发出去的**纯文字战报**。
 *
 * 历史：这里原来是 `buildBubbles()`，会按「①脸图+台词 ②技能图+战报 ③效果图」
 * 组装**三个气泡**并配图。用户 2026-10-04 要求**去掉配图，改纯文字对战** ——
 * 原因是配图这条路投入产出比太差（贴吧占位图、Fandom 画廊夹别人画面、
 * Pixiv 需代理且质量参差），而文字部分本来就完整。
 *
 * 现在返回**一个**气泡对象（仍保留 `{kind, text}` 形状，方便调用方少改）：
 *   · kind = 'battle'
 *   · file = null（不再有图）
 *   · text = 章节 + 血条 + 台词 + 战斗过程 + 选项
 *
 * 台词与章节逻辑**原样保留** —— 那些是内容，不是配图。
 */
function buildReport(b, p, {
  acts, died, victory, opts, narration,
  bossSkill, playerSkill, chapter,
  mahoragaAct, mahoragaDestroyed,
}) {
  const mood = judgeMood(b, { died, blackFlash: false })
  const moodCfg = MOOD_SLOTS[mood] || MOOD_SLOTS.normal
  const line = pickLine(moodCfg.lines, b.turn)
  const chap = chapter || chapterForTurn(b.turn)

  // 出招提示语：宿傩放了什么招 / 玩家出了什么招
  const who = bossSkill || null
  const castTip = who
    ? (SKILL_VISUAL[who]?.cast?.tip || '')
    : (PLAYER_VISUAL[playerSkill?.id]?.tip || '')

  const lines = []
  lines.push(`【${chap.name}】${chap.intro}`)
  lines.push(`${HP_BAR.boss} ${SUKUNA.name}　〔${moodCfg.label}〕`)
  lines.push(line)

  const effTip = who ? (SKILL_VISUAL[who]?.effect?.tip || '') : ''

  lines.push(bb())
  lines.push(acts.join('\n'))
  lines.push(bb())
  lines.push(bossLine(b))

  // ── 魔虚罗状态条（存在时插在宿傩下面）──
  if (b.mahoraga) {
    lines.push(mahoragaStatus(b.mahoraga))
  }

  lines.push(playerLine(p))

  // ── 排队队列（多人时才显示）──
  if (Array.isArray(b.queue) && b.queue.length > 1) {
    lines.push(`排队中（${b.queue.length - 1} 人）：`
      + b.queue.slice(1).map((x, i) => `${i + 1}. ${x.name}`).join(' → '))
  }

  const powerPct = Math.round(p.powerRatio * 100)
  lines.push(`实力：宿傩的 ${powerPct}%　黑闪 ${p.blackFlashCount} 次　阵亡 ${b.casualties.length} 人`)
  if (effTip) lines.push(`【术式效果】${effTip}`)

  // ⚠️ 转职提示与出招选项**同时显示**，用两套互不冲突的输入：
  //    转职 → 回复**名字**；出招 → 回复**数字**。
  //    这样玩家不必卡着不回，可以边打边想（见 looksLikeBranchName 注释）。
  if (b.evolveChoice && b.evolveChoice.id === p.id) {
    lines.push(bb())
    lines.push('【黑闪 · 命运的岔路】回复你要走的路的**名字**（不消耗回合，可以边打边定）：')
    lines.push(EVOLUTION_CHOICE.branches
      .map((x) => `　${x.icon}【${x.name}】${x.desc}`).join('\n'))
    lines.push(`　→ 回复「${EVOLUTION_CHOICE.branches[0].name}」或「${EVOLUTION_CHOICE.branches[1].name}」`)
  }
  if (opts.length) {
    lines.push(bb())
    lines.push('【选择你的行动】')
    lines.push(renderOptions(opts))
    lines.push('')
    lines.push(choiceHint())
  }

  // ── 旁白（用户 2026-10-04 新增：把"第三气泡"换成解说）──
  //
  // 用户原话："第三气泡改为旁白，把对战斗的讲解描绘出来，可以参考当今解说文案"
  //
  // ⚠️ v2.0.0 已经取消三气泡，所以这里不是"改第三个"，而是**新增一个旁白段**。
  //    放在最后而不是最前：读者先看数据，再看解说收情绪 ——
  //    解说放前面会把血条和数字挤到没人看。
  const narr = renderNarration(narration, { died, victory, trueForm: b.boss.trueForm, mahoragaDestroyed })
  if (narr) {
    lines.push(bb())
    lines.push(narr)
  }

  return { kind: 'battle', file: null, text: lines.join('\n') }
}

/**
 * 渲染旁白解说。
 *
 * 风格：电竞赛事解说的短句节奏 —— 制造画面感与情绪，**不复述数值**
 * （数值上面已经有了，旁白再念一遍就是啰嗦）。
 *
 * ⚠️ 表头固定用「旁白」，不要随状态变（曾经在真身时改成"解说席"，
 *    结果同一局的旁白段一会儿叫这个一会儿叫那个，读者反而困惑）。
 */
function renderNarration(narration, { died, victory, trueForm, mahoragaDestroyed } = {}) {
  const parts = []
  if (Array.isArray(narration)) parts.push(...narration.filter(Boolean))

  // 没凑到内容时补一句常规解说，避免旁白段空空荡荡
  if (!parts.length && !died && !victory) {
    parts.push(pickLine(NARRATION.normal, Date.now() % NARRATION.normal.length))
  }
  if (!parts.length && trueForm) parts.push(pickLine(NARRATION.trueForm, 0))
  if (!parts.length && mahoragaDestroyed) parts.push('法轮停了。它适应了一万种术式，只差这一种。')
  if (!parts.length) return ''

  return ['📺 【旁白】', ...parts.map((x) => `　${x}`)].join('\n')
}

/** 判定宿傩此刻该摆什么表情 */
function judgeMood(b, { died, blackFlash }) {
  if (b.boss.hp <= 0) return 'dying'
  if (died) return 'triumph'
  if (b.boss.interruptLeft > 0 && blackFlash) return 'interrupted'
  if (b.boss.lastSkillId === 'domain') return 'domain'
  if (b.boss.reversed && b.boss.hp < 55) return 'healing'
  if (b.boss.hp <= 25) return 'dying'
  if (b.boss.hp <= 60) return 'hurt'
  if (b.turn <= 1) return 'entrance'
  return 'normal'
}

/** 收尾提示：告诉群友怎么选 */
function choiceHint() {
  return '回复 1 / 2 / 3 选一个出招（也可以直接说招式名）。'
}

/**
 * 把群友发的内容解析成招式。
 * 支持：序号 "1"/"2"/"3"、"①"、"第一项"；招式名（含部分匹配）；没选则用第一项。
 */
function resolveChoice(arg, pending, b) {
  const list = Array.isArray(pending) ? pending : []

  // 调用方直接给了 action（start / 老调用点）→ 合成一个等价招式
  if (!arg || typeof arg !== 'string') {
    if (list.length) return list[0]
    return { id: 'punch', name: '咒力打击', icon: '👊', kind: (typeof arg === 'string' ? arg : 'attack') || 'attack' }
  }

  const raw = arg.trim()
  const low = raw.toLowerCase()

  // ① 序号
  const numMap = { '1': 0, '2': 1, '3': 2, '4': 3, '5': 4, '①': 0, '②': 1, '③': 2 }
  if (numMap[raw] !== undefined && list[numMap[raw]]) return list[numMap[raw]]
  const m = raw.match(/^(?:第)?\s*([1-5])\s*(?:项|个|招)?$/)
  if (m) {
    const idx = Number(m[1]) - 1
    if (list[idx]) return list[idx]
  }

  // ② 招式名（全名或包含）
  for (const sk of list) {
    if (low.includes(String(sk.name).toLowerCase())) return sk
  }

  // ③ 退回底层行动名（attack/defend/reverse）——兼容旧调用
  if (['attack', 'defend', 'reverse'].includes(low)) {
    const hit = list.find((sk) => sk.kind === low)
    return hit || { id: low, name: ACTIONS[low]?.name || low, icon: '❔', kind: low }
  }

  // ④ 都没匹配上 → 用第一项（不惩罚手滑）
  return list[0] || { id: 'punch', name: '咒力打击', icon: '👊', kind: 'attack' }
}

/* ── 工具 ───────────────────────────────────────────────────────── */

function registerTools() {
  /* 工具零：开局（用户要求的两步确认流程的第二步） */
  api.registerTool({
    id: 'start',
    name: '开启宿傩讨伐战',
    description:
      '正式开启宿傩讨伐战（BOSS 战）。用于群友被 @ 后明确表示要打的场合，'
      + '例如「我要打宿傩」「开一局」「开BOSS」。'
      + '⚠️ 只有在群友**明确同意开打**时才调用；只是提到宿傩/聊剧情时不要调，'
      + '那种情况应该先回一句「要打宿傩吗」问他。'
      + '开局后会立刻结算第一回合。',
    category: 'utility',
    icon: '🔥',
    parameters: {
      type: 'object',
      properties: {
        choice: {
          type: 'string',
          description: '群友选的那一项：序号 1/2/3，或招式名（如「简易领域」）。没选就留空，默认第一项。'
        }
      },
      required: [],
      additionalProperties: false
    },
    async execute(ctx, args) {
      const cfg = cfgOf()
      if (cfg.enabled === false) return { content: '宿傩讨伐战已关闭（设置里可开）。', isError: true }
      if (!isMentioned(ctx)) {
        return { content: '没被 @，不开局。想打的话 @ 我一下。', isError: true }
      }

      const b = getBattle(ctx.chatKey)
      // 已经在打 → 不要重开，改成"继续"
      if (b.turn > 0 && b.boss.hp > 0) {
        return {
          content: `这一局已经在打了（第 ${b.turn} 回合，${SUKUNA.name}剩 ${b.boss.hp.toFixed(1)}%）。`
            + '直接说你出什么招就行 —— 不用重新开局。'
            + `如果想满血重来，说「重开一局」。`,
        }
      }

      // 登场演出先发出去（宿傩不是群成员，是机器人演出来的文字 BOSS）
      const opening = pickOpening()
      const head = `${bossBanner()}\n`
        + `${opening}\n`
        + bb() + '\n'
        + `【宿傩讨伐战 · 开始】${SUKUNA.name}登场，挑战开始。\n`
        + '规则：所有伤害为百分比；只有黑闪能打 5% 并中断他的反转术式 3 回合。'
        + '咒术师只有他 20% 的实力 —— 单挑几乎必败，靠大家接力。\n'
        + '👥 多人同时上 → **按顺序排队上场**，前一个倒下才轮到下一个。\n'
        + '⚠️ 他同时面对两个人以上时，可能变身**四手平安宿傩**（回血但术式变钝）。'
      await sendText(ctx, head)

      const r = await takeTurn(ctx, args?.choice)
      if (!r.ok) {
        await sendText(ctx, r.error)
        return { content: r.error, isError: true }
      }
      // ⚠️ 战报已由 takeTurn 直接发进群。这里只回一句回执给模型，
      //    明确告诉它"别复述"——否则模型会再写一遍数字，群里就重了。
      return {
        content: r.queued
          ? `【回执】该群友在排队（第 ${r.position + 1} 位）。不要复述。`
          : (r.died
            ? '【回执】战报已发送。该玩家阵亡，广播已播。不要复述战报内容，只需一句氛围话。'
            : (r.opts?.length
              ? '【回执】战报已发送（含三选项）。不要复述战报，静待群友回复序号。'
              : '【回执】战报已发送。不要复述战报内容。')),
        // 机器可读：这一轮发出去的战报
        report: r.report, chapter: r.chapter,
        trueForm: r.trueForm, queue: r.queue, mahoraga: r.mahoraga,
      }
    }
  })

  api.registerTool({
    id: 'join',
    name: '上场打宿傩',
    description:
      '被 @ 的人上场挑战两面宿傩。会自动结算一回合：你出手 → 宿傩出手 → 出状态条战报，'
      + '宿傩的血量与状态**跨玩家沿用**，不会因为换人而重置。'
      + '⚠️ **多人排队制**：如果已经有人在打，这个人会**进入队列**'
      + '（返回的是一句"排队中"，不是战报）。前一个战死才轮到他。'
      + '用户说「打宿傩」「我来打」「上」时调用。**只有被 @ 才能上场。**',
    category: 'utility',
    icon: '👹',
    parameters: {
      type: 'object',
      properties: {
        choice: {
          type: 'string',
          description: '群友选的那一项：序号 1/2/3、①②③，或招式名（如「简易领域」「反转术式」）。留空则默认第一项。'
        }
      },
      required: [],
      additionalProperties: false
    },
    async execute(ctx, args) {
      const cfg = cfgOf()
      if (cfg.enabled === false) return { content: '宿傩讨伐战已关闭（设置里可开）。', isError: true }
      if (!isMentioned(ctx)) {
        return { content: '没被 @，不上场。想打的话 @ 我一下。', isError: true }
      }
      const r = await takeTurn(ctx, args?.choice)
      if (!r.ok) {
        await sendText(ctx, r.error)
        return { content: r.error, isError: true }
      }
      // 战报已由 takeTurn 直接发进群 —— 这里只给模型一句回执，禁止复述。
      return {
        content: r.queued
          ? `【回执】该群友在排队（第 ${r.position + 1} 位）。排队提示已发进群，不要复述。`
          : (r.died
            ? '【回执】战报已发送，该玩家阵亡，接力广播已播。不要复述战报，只说一句氛围话。'
            : (r.opts?.length
              ? '【回执】战报已发送（含三选项）。不要复述战报，静待群友回复序号。'
              : '【回执】战报已发送。不要复述战报内容。')),
        report: r.report, chapter: r.chapter,
        trueForm: r.trueForm, queue: r.queue, mahoraga: r.mahoraga,
      }
    }
  })

  /* 工具：出招 —— 群友回复 1/2/3 时用这个 */
  api.registerTool({
    id: 'choose',
    name: '宿傩战·出招',
    description:
      '宿傩讨伐战进行中，群友回复序号（1/2/3）或招式名时调用，结算这一回合。'
      + '用户回「1」「2」「3」「我选2」「用反转术式」等都属于这个工具。'
      + '⚠️ 不需要 @ 也能调用（只要战局是开着的、这个人是当前出战者）。'
      + '⚠️ 如果群友回的是**「虎杖」/「伏黑」**，那是**选转职路线**（黑闪后出现），'
      + '也走这个工具，`choice` 原样填名字即可。'
      + '注意：数字 1/2/3 永远表示**出招**，不是转职。'
      + '战报由技能自己发进群，你**不要复述战报内容**。',
    category: 'utility',
    icon: '⚔️',
    parameters: {
      type: 'object',
      properties: {
        choice: {
          type: 'string',
          description: '群友的选择：序号 1/2/3，或招式名。'
        }
      },
      required: ['choice'],
      additionalProperties: false
    },
    async execute(ctx, args) {
      const cfg = cfgOf()
      if (cfg.enabled === false) return { content: '宿傩讨伐战已关闭（设置里可开）。', isError: true }

      const b = getBattle(ctx?.chatKey)
      if (!b || b.turn === 0 || b.boss.hp <= 0) {
        return { content: '现在没有进行中的宿傩战。想开打就说「打宿傩」。', isError: true }
      }
      // 出招不强制 @ —— 群里连着打的时候，回数字是最自然的操作。
      // 但仍然要求"是当前出战者"，避免别人插队改战果。
      const who = whoIs(ctx)
      const p = getPlayer(who.id, who.name)

      // ⚠️ 转职选择**不走出战者检查**（只有本人能回，且不影响别人）。
      //    但注意：只有回"名字"才是选转职；回数字仍然是出招。
      const isEvolving = b.evolveChoice && b.evolveChoice.id === p.id
        && looksLikeBranchName(args?.choice)

      if (!isEvolving && b.fighter && b.fighter !== p.id) {
        const cur = b.fighterName || '上一位出战者'
        const pos = queuePosition(b, p.id)
        return {
          content: `现在是 ${cur} 在打，还没轮到你 —— 排队制，前一个倒下才轮到你。`
            + (pos > 0 ? `（你在队列第 ${pos + 1} 位）` : ''),
          isError: true,
        }
      }

      const r = await takeTurn(ctx, args?.choice)
      if (!r.ok) {
        await sendText(ctx, r.error)
        return { content: r.error, isError: true }
      }
      return {
        content: r.queued
          ? `【回执】在排队（第 ${r.position + 1} 位）。不要复述。`
          : (r.died
            ? '【回执】战报已发送，该玩家阵亡，接力广播已播。不要复述战报。'
            : (r.opts?.length
              ? '【回执】战报已发送（含三选项）。不要复述战报，静待群友回复序号。'
              : '【回执】战报已发送。不要复述战报内容。')),
        report: r.report, chapter: r.chapter,
        trueForm: r.trueForm, queue: r.queue, mahoraga: r.mahoraga,
      }
    }
  })

  api.registerTool({
    id: 'status',
    name: '查看宿傩战况',
    description:
      '查看当前宿傩的血量、反转术式状态、回合数、阵亡名单，以及你自己的角色数据'
      + '（血量、是否已进化为虎杖悠仁、黑闪次数、实力百分比）。'
      + '用户问「宿傩还剩多少血」「战况如何」「我什么实力」时调用。',
    category: 'utility',
    icon: '📊',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    async execute(ctx) {
      const b = getBattle(ctx?.chatKey)
      const who = whoIs(ctx)
      const p = getPlayer(who.id, who.name)
      const lines = []
      lines.push(`【${SUKUNA.name} 讨伐战】第 ${b.turn} 回合`)
      lines.push(bb())
      lines.push(bossStatus(b))
      // 真身状态（用户新增）
      if (b.boss.trueForm) {
        lines.push(`　⚠️ 当前形态：${SUKUNA_TRUE_FORM.formName}（四手四目）`)
        lines.push(`　技能威力被压到 ${Math.round(SUKUNA_TRUE_FORM.dmgMul[0] * 100)}%~`
          + `${Math.round(SUKUNA_TRUE_FORM.dmgMul[1] * 100)}%；虎杖攻击有奇效`)
      }
      if (b.boss.stunned > 0) lines.push(`　💫 眩晕中（剩 ${b.boss.stunned} 回合不行动）`)
      // 魔虚罗
      if (b.mahoraga) {
        lines.push(bb())
        lines.push(mahoragaStatus(b.mahoraga))
      } else if (b.mahoragaCast) {
        lines.push(`　⚔️ ${b.mahoragaCast.name} 正在吟唱召唤魔虚罗……`)
      }
      lines.push(bb())
      lines.push(playerStatus(p))
      const br = EVOLUTION_CHOICE.branches.find((x) => x.key === p.branch)
      const who2 = br ? br.name : (p.evolved ? EVOLUTION.to : EVOLUTION.from)
      lines.push(`实力：宿傩的 ${Math.round(p.powerRatio * 100)}%（${who2}，满编 ${SUKUNA_POWER}%）`)
      if (p.branch === 'megumi') {
        lines.push(`十种影法术：已解锁　魔虚罗通道：${p.mahoragaUsed ? '已用过' : `血 <${MAHORAGA_SUMMON.hpBelow}% 可召唤`}`)
      }
      // 排队队列
      if (Array.isArray(b.queue) && b.queue.length) {
        lines.push(bb())
        lines.push(`👥 出战队列（${b.queue.length} 人）：`)
        lines.push(b.queue.map((x, i) => `　${i + 1}. ${x.name}${i === 0 ? ' ← 正在打' : ''}`).join('\n'))
      }
      if (b.evolveChoice) {
        lines.push(`✦ 等待 ${b.evolveChoice.name} 选择转职路线（回复 1 虎杖 / 2 伏黑）`)
      }
      if (b.casualties.length) {
        lines.push(`阵亡名单（${b.casualties.length} 人）：${b.casualties.map((c) => c.name).join('、')}`)
      }
      return { content: lines.join('\n') }
    }
  })

  api.registerTool({
    id: 'reset',
    name: '重开宿傩战局',
    description:
      '把宿傩血量恢复 100%、清空反转术式状态与阵亡名单（玩家个人数据如进化保留）。'
      + '只在用户明确说「重开」「重新开始」「满血重打」时调用。',
    category: 'utility',
    icon: '🔄',
    parameters: {
      type: 'object',
      properties: {
        keep_players: { type: 'boolean', description: '是否保留玩家个人数据（进化/黑闪次数）。默认 true。' }
      },
      required: [],
      additionalProperties: false
    },
    async execute(ctx, args) {
      const chatKey = ctx?.chatKey
      if (!chatKey) return { content: '拿不到会话标识。', isError: true }
      const old = getBattle(chatKey)
      const nb = newBattle()
      saveBattle(chatKey, nb)

      // ⚠️ 光重建 Battle 不够 —— 玩家数据在另一个文件里，**不会**跟着重置。
      //    不处理的话：战死者 `alive:false` 一直留着，
      //    "重开一局才能再上"这句提示就成了空头支票（真的发生过）。
      let revived = 0
      if (args?.keep_players === false) {
        writeJson(playersFile(), {})
      } else {
        const all = readJson(playersFile(), {})
        for (const k of Object.keys(all)) {
          const p = all[k]
          if (!p) continue
          const wasOut = !p.alive || p.hp <= 0
          reviveForNewGame(p)
          if (wasOut) revived += 1
        }
        writeJson(playersFile(), all)
      }
      const n = Object.keys(readJson(playersFile(), {})).length

      return {
        content: `${SUKUNA.name}恢复了全盛状态（100% 血量，反转术式就绪）。`
          + `上一局纪录：打到第 ${old.turn} 回合、阵亡 ${old.casualties.length} 人。`
          + '出战队列、真身形态、魔虚罗均已重置。'
          + (args?.keep_players === false
            ? '玩家个人数据已清空。'
            : `保留了 ${n} 名玩家的转职进度，并把血量补满`
              + (revived ? `（${revived} 名战死者已可重新上场）` : '') + '。')
      }
    }
  })

  // （原 `sukuna-raid__art` 配图管理工具已随配图功能移除 —— 纯文字对战）
}

/* ── 生命周期 ───────────────────────────────────────────────────── */

export function setup(_api) {
  api = _api
  cfgOf = () => (api?.config ? (api.config() || {}) : {})
  log = (...a) => { try { api.log(...a) } catch { /* noop */ } }
  registerTools()
  api.log(`${ID} 已就绪（工具：${ID}__start / ${ID}__choose / ${ID}__join / ${ID}__status / ${ID}__reset）`)
}

export function available() { return { ok: true } }

/**
 * 被 @ 时注入一小段规则提示。
 * 为什么要注入：模型不知道"宿傩不会重置""只有黑闪有用"这些设定，
 * 会自己瞎编数值。给它一段简短的规则，它才不会乱写。
 */

/* ── 钩子：捕获本轮触发消息（工具里取不到，只能在这里记）───────────── */
export const hooks = {
  async 'before-context'(ctx = {}) {
    rememberTriggers(ctx)
  },
  async 'before-tool'(ctx = {}) {
    rememberTriggers(ctx)
  },
}

export function promptSections(ctx = {}) {
  const cfg = cfgOf()
  if (cfg.enabled === false) return []
  try {
    if (!isMentioned(ctx)) return []

    const b = getBattle(ctx.chatKey)
    const act = activationWords().join(' / ')
    const running = b.turn > 0 && b.boss.hp > 0
    const hit = hitActivation(ctx)

    // ── 情况一：这一局正在打 ──
    if (running) {
      const who = whoIs(ctx)
      const p = getPlayer(who.id, who.name)
      return [{
        id: 'sukuna-raid-hint',
        title: '宿傩讨伐战',
        content:
          `${SUKUNA.name}剩 ${b.boss.hp.toFixed(1)}%，第 ${b.turn} 回合。`
          + `${who.name} 当前 ${p.hp.toFixed(0)}/${p.maxHp} 血`
          + `${p.evolved ? '，已进化为虎杖悠仁' : '，还是咒术师'}。`
          + '玩法是**三选一出招**：每回合战报末尾摆 ①②③ 三个随机招式，'
          + '群友回复序号（1/2/3）或招式名出招 → 调 sukuna-raid__choose，choice 填他的选择。'
          + '问战况调 sukuna-raid__status。'
          + '**战报由技能自己发进群了，绝对不要复述战报里的数字**；'
          + '最多补一句氛围话（≤20 字），也可以什么都不说。',
        priority: 44,
      }]
    }

    // ── 情况二：没在打，且没命中激活词 → 不打扰 ──
    if (!hit) return []

    // ── 情况三/四：命中激活词 → 直接开局（用户要求"问起就会开启boss战"）──
    return [{
      id: 'sukuna-raid-hint',
      title: '宿傩讨伐战',
      content:
        `消息里出现了激活词（${act}）—— 群友在问/要打宿傩。`
        + '按"问起就开启"的设定，直接调 sukuna-raid__start 开局（宿傩会登场，战报会发进群）。'
        + '开局后是**三选一**玩法：每回合摆 ①②③ 三个随机招式，'
        + '群友回序号出招，之后调 sukuna-raid__choose。'
        + '设定：宿傩 100% 血、每回合自愈 2%；只有黑闪能打 5% 并中断反转术式 3 回合；'
        + '咒术师只有他 20% 实力（虎杖 30%），单挑几乎必败，靠大家接力。'
        + '战死会播报「连一刻也没有为XXX而哀悼，下一个奔赴战场的是！」',
      priority: 44,
    }]
  } catch (e) {
    log(`提示词注入失败：${String(e?.message || e).slice(0, 60)}`)
    return []
  }
}

export function dispose() {
  api = null
  cfgOf = () => ({})
  log = () => {}
}

export const internals = {
  getBattle, saveBattle, getPlayer, savePlayer, takeTurn,
  whoIs, isMentioned, DATA_DIR, storeDir,
}
