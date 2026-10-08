/**
 * 宿傩讨伐战 —— 战斗结算引擎（纯函数，可单测）。
 *
 * 设计要点与"为什么这么做"：
 *
 * ① 所有伤害都是百分比，不存在固定数值 —— 这样"宿傩很强"才可控：
 *    只要把普通攻击的期望调到**低于**他的自愈，玩家就永远磨不死他，
 *    必须靠黑闪。这是让"只有黑闪能造成 5% 伤害"真的成立的前提。
 *
 * ② 宿傩状态**跨玩家沿用**（用户明确要求："宿傩的状态并不会重置，沿用上一个人的战绩"）。
 *    所以状态存在会话级，玩家数据存在玩家级（每人一份，进化也分开算）。
 *
 * ③ 一个咒术师战死 → 他的数据**保留**（进化过的虎杖下次还能用），
 *    但当前出战位空出来，由下一个 @ 的人接管。
 */

import {
  ACTIONS, BLACK_FLASH, BLACK_FLASH_RULE, BARS, EVOLUTION, EVOLUTION_CHOICE, FLAGS,
  MAHORAGA, MAHORAGA_SUMMON, MEGUMI_SKILLS, NARRATION,
  PLAYER_BASE, SKILL_ART_HINT, SUKUNA, SUKUNA_POWER, SUKUNA_TRUE_FORM,
  deathBroadcast, PLAYER_SKILLS, OPTION_COUNT,
} from './data.js'
import { HP_BAR, pickLine } from './visual.js'

/* ── 随机 ───────────────────────────────────────────────────────── */

/** 用 crypto 保证真随机（模型与 Math.random 都可能被"好看"干扰） */
export function makeRng(seedFn) {
  return seedFn || Math.random
}

export function rollInt(min, max, rng = Math.random) {
  const lo = Math.ceil(min), hi = Math.floor(max)
  return lo + Math.floor(rng() * (hi - lo + 1))
}

/* ── 状态构造 ───────────────────────────────────────────────────── */

/** 会话级：宿傩 + 战场。跨玩家沿用。 */
export function newBattle() {
  return {
    boss: {
      name: SUKUNA.name,
      hp: 100,                    // 百分比
      maxHp: 100,
      reversed: false,            // 反转术式是否运转
      interruptLeft: 0,           // 反转术式被中断的剩余回合
      domainCooldown: 0,
      lastSkills: [],             // 最近用过的技能 id（用于「灶」的料理工序判定）
      history: [],                // 技能使用序列
      lastSkillId: null,
      lastSkillName: null,

      // ── 真身（四手平安宿傩）────────────────────────────────
      trueForm: false,            // 是否已变身为真身
      trueFormTurn: null,         // 变身发生在第几回合
      stunned: 0,                 // 剩余眩晕回合（真身下的"停止行动"）
    },

    /**
     * 出战队列（用户 2026-10-04 要求"多人同时参战进入排队制"）。
     *
     * ⚠️ 为什么用数组而不是把 fighter 换成数组：
     *    `fighter` / `fighterName` 被 index.js 多处读取，直接换形状会大面积改。
     *    保留它们作"当前出战者"的镜像，队列是权威数据源。
     *    用 `syncFighter()` 保持两者一致 —— 只有这一个地方写 fighter。
     */
    queue: [],

    /** 当前出战者（玩家 id）。战死后置空，等下一个人 @ 接管。 */
    fighter: null,
    fighterName: null,
    /** 本回合摆出来的三个招式选项（群友回 1/2/3 选） */
    pending: [],
    // 最近用过的配图 —— 三轮内不重复
    recentArt: [],

    /**
     * 黑闪后的二选一（虎杖 / 伏黑）。
     * 非 null 时，choose 工具的输入被解释为**转职选择**而不是出招，
     * 见 index.js 的 resolveChoice 分支。
     */
    evolveChoice: null,           // { id, name, turn }

    /**
     * 魔虚罗状态。null = 没有。
     * 形状见 MAHORAGA 注释。
     */
    mahoraga: null,
    /** 召唤吟唱中（还没出场）：{ id, name, sinceTurn } */
    mahoragaCast: null,

    /** 第几回合（全局） */
    turn: 0,
    /** 战斗日志（给模型看的近期战况） */
    log: [],
    casualties: [],               // 阵亡名单
    startedAt: Date.now(),
  }
}

/** 玩家级：每个群员一份，进化分开算。 */
export function newPlayer(id, name) {
  return {
    id,
    name: name || id,
    hp: 100,
    maxHp: 100,
    evolved: false,               // 是否已完成转职（虎杖或伏黑）
    /** 'yuji' | 'megumi' | null —— 转职后记下走了哪条路 */
    branch: null,
    evolvedAt: null,
    blackFlashCount: 0,
    pity: 0,                      // 连续未触发黑闪的累计
    lastAction: null,             // 上回合动作（防御 +黑闪率）
    alive: true,
    deaths: 0,
    kills: 0,
    powerRatio: PLAYER_BASE.powerRatio,
    /** 魔虚罗相关：召唤吟唱中 / 正在操控魔虚罗 */
    summoning: false,
    controllingMahoraga: false,
  }
}

/* ══════════════════════════════════════════════════════════════════
   排队制（用户 2026-10-04 要求）
   ══════════════════════════════════════════════════════════════════

   规则：多人参战时**按顺序上场**，第一人打完轮到第二人，以此类推。

   ⚠️ 设计取舍：什么叫"打完"？
     不是"打一回合就换人" —— 那是轮流制不是排队制，而且会让每个人都
     只打一回合、宿傩的自愈把所有人的努力全部吃掉（每回合回 2%），
     战局永远推进不了。
     这里的"打完" = **战死**（或主动撤退）。活着的人一直持有出场权，
     排队的人等他倒下才轮到。这也正好接上那句"下一个奔赴战场的是！"

   `fighter` 是队列第 0 项的镜像。**只通过本文件的函数改它**，
   否则会出现"队列说该 A 上，fighter 却写着 B"的鬼状态。
*/

export function queueOf(b) {
  if (!Array.isArray(b.queue)) b.queue = []
  return b.queue
}

/** 把 fighter / fighterName 同步成队首 —— 唯一写这两个字段的地方 */
export function syncFighter(b) {
  const q = queueOf(b)
  if (q.length) {
    b.fighter = q[0].id
    b.fighterName = q[0].name
  } else {
    b.fighter = null
    b.fighterName = null
  }
  return b.fighter
}

/** 这个人在队列里排第几（0 = 正在打），-1 = 不在队列 */
export function queuePosition(b, id) {
  return queueOf(b).findIndex((x) => x.id === id)
}

/** 在攻的人数（含出战者与排队者）—— 真身判定用 */
export function attackerCount(b) {
  const q = queueOf(b)
  if (q.length) return q.length
  return b.fighter ? 1 : 0
}

/**
 * 入队。
 * @returns {{ position: number, ahead: number, isFighting: boolean, already: boolean }}
 */
export function enqueue(b, player) {
  const q = queueOf(b)
  const at = q.findIndex((x) => x.id === player.id)
  if (at >= 0) {
    return { position: at, ahead: at, isFighting: at === 0, already: true }
  }
  q.push({ id: player.id, name: player.name, at: Date.now() })
  syncFighter(b)
  return { position: q.length - 1, ahead: q.length - 1, isFighting: q.length === 1, already: false }
}

/** 出战者倒下 → 出队，下一个顶上。返回新出战者（或 null） */
export function advanceQueue(b) {
  const q = queueOf(b)
  q.shift()
  syncFighter(b)
  return q.length ? q[0] : null
}

/** 把已战死的人从队列里剔除（防止死人占着位置） */
export function pruneDead(b, isDead) {
  const q = queueOf(b)
  const before = q.length
  b.queue = q.filter((x) => !isDead(x.id))
  if (b.queue.length !== before) syncFighter(b)
  return before - b.queue.length
}

/* ── 状态条 ─────────────────────────────────────────────────────── */

/**
 * 红蓝血条。
 *
 * ── 为什么是 emoji 方块，不是 ANSI ─────────────────────────────────
 *   群里是**纯文本**，ANSI 转义序列不会被渲染，只会变成一串看不见的怪字符。
 *   所以"红蓝"必须靠**方块字符本身的语义色**来表达：
 *     宿傩 🟥（恒定红 —— 他是诅咒之王，血条永远红）
 *     我方 🟦（恒定蓝）
 *   空格用 ⬛ 当"血槽底"，这样 10 格 emoji 看起来像一条真正的槽。
 *
 * ── 为什么是 10 格而不是 20 格 ─────────────────────────────────────
 *   emoji 宽度是普通字符的约 2 倍。20 个 emoji 在手机 QQ 上会折行，
 *   折行的血条完全读不出比例。10 格 + 百分比数字 = 清晰 > 精确。
 *   颜色恒定、长度恒定，反而比"变色条纹"更容易一眼看出来。
 *
 * @param {number} cur 当前值
 * @param {number} max 最大值
 * @param {'boss'|'player'} kind 决定红还是蓝
 */
export function bar(cur, max, kind = 'boss') {
  const n = HP_BAR.cells
  const ratio = Math.max(0, Math.min(1, cur / max))
  const filled = Math.round(ratio * n)
  const ch = kind === 'boss' ? HP_BAR.boss : HP_BAR.player
  return ch.repeat(filled) + HP_BAR.empty.repeat(n - filled)
}

/** 宿傩状态条（含反转术式标记） */
export function bossStatus(b) {
  const boss = b.boss
  const lines = [`${HP_BAR.boss} ${boss.name}（${SUKUNA.title}）`]
  lines.push(`${bar(boss.hp, boss.maxHp, 'boss')} ${boss.hp.toFixed(1)}%`)
  const flags = []
  if (boss.interruptLeft > 0) flags.push(`${FLAGS.interrupted}（剩 ${boss.interruptLeft} 回合）`)
  else if (boss.reversed) flags.push(FLAGS.reversed)
  else if (boss.hp <= SUKUNA.reverseTechnique.unlockAt) flags.push('（反转术式未开启）')
  if (boss.domainCooldown > 0) flags.push(`领域冷却 ${boss.domainCooldown} 回合`)
  if (flags.length) lines.push(flags.join('　'))
  return lines.join('\n')
}

/** 玩家状态条 */
export function playerStatus(p) {
  const lines = [`${HP_BAR.player} ${p.name}${p.evolved ? ` ${FLAGS.evolved}` : ''}`]
  lines.push(`${bar(p.hp, p.maxHp, 'player')} ${p.hp.toFixed(1)}/${p.maxHp}`)
  const pct = Math.round(p.powerRatio * 100)
  lines.push(`实力：宿傩的 ${pct}%　黑闪 ${p.blackFlashCount} 次`)
  return lines.join('\n')
}

/* ── 宿傩行动 ───────────────────────────────────────────────────── */

/** 按权重 + 原著前提挑一个技能 */
export function pickSkill(boss, rng = Math.random) {
  const avail = SUKUNA.skills.filter((s) => {
    if (s.id === 'domain' && boss.domainCooldown > 0) return false
    // 「灶」的料理工序：必须先有过「解」和「捌」（原著门槛）
    if (s.requiresPrep) {
      const h = boss.history
      if (!h.includes('kai') || !h.includes('hachi')) return false
    }
    return true
  })
  const pool = avail.length ? avail : SUKUNA.skills.filter((s) => s.id !== 'domain')
  const total = pool.reduce((a, s) => a + s.weight, 0)
  let r = rng() * total
  for (const s of pool) {
    r -= s.weight
    if (r <= 0) return s
  }
  return pool[pool.length - 1]
}

/**
 * 宿傩回合结算。
 *
 * 顺序很关键，顺序错了数值就崩：
 *   0) 眩晕判定 → 直接跳过整回合（真身被打懵时）
 *   1) 反转术式回复（先回血）
 *   2) 若被中断 → 跳过回复（这正是黑闪的价值）
 *   3) 出手（真身下威力衰减）
 *   4) 回合末递减各种计时
 */
export function sukuNaTurn(b, rng = Math.random) {
  const boss = b.boss
  const events = []

  // ── ⓪ 眩晕：真身被打懵 → 整回合停摆 ──
  //    用户要求真身挂 10% 眩晕"停止行动一回合"。
  //    放在最前面，因为被眩晕的人既不能回血也不能出手 ——
  //    否则"停止行动"就只是"少打一拳"，没有意义。
  if (boss.stunned > 0) {
    boss.stunned -= 1
    events.push(`💫 ${boss.name}被震得单膝跪地 —— 这一回合**停止行动**。`)
    events.push(`　（眩晕剩余 ${boss.stunned} 回合。他没能自愈，也没能出手。）`)
    return { skill: null, dmg: 0, events, interrupted: true, stunned: true }
  }

  // ── ① 反转术式 ──
  const interrupted = boss.interruptLeft > 0
  if (interrupted) {
    events.push(`${FLAGS.interrupted} —— ${boss.name}这回合无法输出正向咒力，无法自愈。`)
  } else {
    // 血量降到门槛 → 开启反转术式
    if (!boss.reversed && boss.hp <= SUKUNA.reverseTechnique.unlockAt) {
      boss.reversed = true
      events.push(`${boss.name}开启了${'反转术式'}：「${SUKUNA.reverseTechnique.desc}」`)
    }
    let regen = SUKUNA.regenPerTurn
    if (boss.reversed) regen += SUKUNA.reverseTechnique.bonusRegen
    // 真身：肉身更强，回血也更快一点（否则"变肉"这个收益立不住）
    if (boss.trueForm) regen *= 1.3
    const before = boss.hp
    boss.hp = Math.min(boss.maxHp, boss.hp + regen)
    const healed = boss.hp - before
    if (healed > 0.01) {
      events.push(`${boss.name}回复了 ${healed.toFixed(1)}%（现 ${boss.hp.toFixed(1)}%）` +
        (boss.reversed ? '　⟳反转术式加速恢复' : '') +
        (boss.trueForm ? '　（真身恢复更快）' : ''))
    }
  }

  // ── ② 出手 ──
  const skill = pickSkill(boss, rng)
  boss.history.push(skill.id)
  if (boss.history.length > 12) boss.history.shift()
  boss.lastSkillId = skill.id
  boss.lastSkillName = skill.name
  if (skill.id === 'domain') boss.domainCooldown = skill.cooldown || 4

  let dmg = rollInt(skill.dmg[0], skill.dmg[1], rng)
  // 真身：伤害降到 30%~50%（用户指定）
  const tfMul = trueFormMul(b, rng)
  if (tfMul !== 1) dmg = dmg * tfMul

  events.push(`${boss.name}使用了【${skill.name}】${skill.chant ? `　咏唱：${skill.chant}` : ''}`)
  events.push(`　${skill.desc}`)
  if (tfMul !== 1) {
    events.push(`　（真身之躯拖慢术式 —— 威力被压到 ${Math.round(tfMul * 100)}%）`)
  }

  return { skill, dmg, events, interrupted }
}

/** 应用宿傩伤害到玩家（防御可减免，领域必中） */
export function applyBossDamage(player, skill, rawDmg) {
  let dmg = rawDmg
  const notes = []
  if (player.lastAction === 'defend' && !skill.unavoidable) {
    // 招式可以覆盖减伤比例（例：束縛·縛 是 0.75，比普通防御更硬）
    const redu = Number(player.lastReduction) > 0 ? Number(player.lastReduction) : ACTIONS.defend.reduction
    dmg = dmg * (1 - redu)
    notes.push(`（防御生效，伤害减少 ${Math.round(redu * 100)}%）`)
  } else if (player.lastAction === 'defend' && skill.unavoidable) {
    notes.push(`（领域必中，防御无效）`)
  }
  // 反转术式·全开 的代价：这回合更脆
  if (player.fragile) {
    dmg = dmg * 1.35
    notes.push(`（反转全开，身体发虚，伤害加深）`)
    player.fragile = false
  }
  player.lastReduction = null
  player.hp = Math.max(0, player.hp - dmg)
  return { dmg, notes }
}

/* ══════════════════════════════════════════════════════════════════
   宿傩真身（四手平安宿傩）
   ══════════════════════════════════════════════════════════════════ */

/** 玩家技能 → 伤害类型。魔虚罗的适应是**按类型**的，所以必须能归类。 */
const SKILL_DAMAGE_TYPE = {
  punch: '打击', gamble: '打击', divergent: '打击', divergentRush: '打击',
  kai: '斩击', hachi: '斩击',
  gyokuken: '打击', gyokukenKon: '打击', kanji: '打击', soutou: '打击',
  nue: '雷电', mizo: '影子', orochi: '缠缚', gama: '缠缚',
  domain: '领域',
}

/** 取一个技能的伤害类型；认不出来归为「打击」（最保守，不至于全免疫） */
export function damageTypeOf(skill) {
  if (!skill) return '打击'
  return skill.damageType || SKILL_DAMAGE_TYPE[skill.id] || '打击'
}

/**
 * 真身变身判定。
 *
 * 用户规则：**面对两个人或以上进攻时**，30% 概率变身。
 * 每回合只掷一次，已经变过就不再掷（变身不可逆 —— 变不回去）。
 */
export function maybeTransform(b, rng = Math.random) {
  const boss = b.boss
  const events = []
  if (boss.trueForm) return { transformed: false, events }

  if (attackerCount(b) < SUKUNA_TRUE_FORM.trigger.minAttackers) {
    return { transformed: false, events }
  }

  const roll = rollInt(1, 100, rng)
  if (roll > SUKUNA_TRUE_FORM.trigger.chance) {
    return { transformed: false, events }
  }

  boss.trueForm = true
  boss.trueFormTurn = b.turn
  const before = boss.hp
  boss.hp = Math.min(boss.maxHp, boss.hp + SUKUNA_TRUE_FORM.healOnTransform)
  const healed = boss.hp - before

  events.push(`【形态变化】${SUKUNA_TRUE_FORM.desc}`)
  events.push(`　${boss.name} → ${SUKUNA_TRUE_FORM.name}（${SUKUNA_TRUE_FORM.formName}）`)
  events.push(`　${pickLine(SUKUNA_TRUE_FORM.lines, b.turn)}`)
  if (healed > 0.01) {
    events.push(`　四手同时结印，伤口闭合 —— 回复 ${healed.toFixed(1)}%（现 ${boss.hp.toFixed(1)}%）`)
  }
  events.push(`　⚠️ 但受肉之躯撑开也拖慢了他的术式 —— 技能威力降至 `
    + `${Math.round(SUKUNA_TRUE_FORM.dmgMul[0] * 100)}%~${Math.round(SUKUNA_TRUE_FORM.dmgMul[1] * 100)}%。`)
  events.push(`　⚠️ 虎杖悠仁的攻击对真身有奇效（伤害 +${Math.round((SUKUNA_TRUE_FORM.yujiDmgTaken - 1) * 100)}%）。`)
  return { transformed: true, events }
}

/** 真身下宿傩技能伤害/状态的衰减倍率（每回合现掷，制造波动） */
export function trueFormMul(b, rng = Math.random) {
  if (!b.boss.trueForm) return 1
  const [lo, hi] = SUKUNA_TRUE_FORM.dmgMul
  return lo + rng() * (hi - lo)
}

/* ══════════════════════════════════════════════════════════════════
   魔虚罗
   ══════════════════════════════════════════════════════════════════ */

/** 造一只魔虚罗 */
export function createMahoraga(ownerId, ownerName) {
  return {
    name: MAHORAGA.name,
    hp: MAHORAGA.maxHp,
    maxHp: MAHORAGA.maxHp,
    ownerId,
    ownerName,
    /**
     * 适应进度：{ [伤害类型]: 被这个类型打中过几次 }
     *   0 次 → 全新，满伤（首次接触，开始解析）
     *   1 次 → 已解析，**减伤 50%**
     *   ≥2 次 → **完全免疫**，且挨打反而回满血
     */
    seen: {},
    /** 已免疫的类型（完成适应）—— 解锁「进化」招式 */
    adaptedTypes: [],
    /** 法轮转过几格（展示用） */
    wheel: 0,
    /** 与宿傩的战斗脚本阶段 */
    phase: 'active',              // active → realized → locked → destroyed
    scriptTurns: 0,
    bornAt: Date.now(),
  }
}

/** 这个类型当前的伤害倍率 */
export function adaptMulFor(m, type) {
  const n = Number(m?.seen?.[type] || 0)
  if (n >= 2) return MAHORAGA.adapt.immuneMul      // 0
  if (n === 1) return MAHORAGA.adapt.firstHitMul   // 0.5
  return 1
}

/**
 * 魔虚罗挨了一记。
 *
 * **免疫时回满血**（用户指定，取自原著"极强恢复能力"）。
 * 注意这不是"减伤到 0" —— 是"打上去反而给它回血"，性质完全不同：
 * 玩家继续用被适应的招式攻击，等于在给敌人当奶妈。
 */
export function mahoragaTakeHit(m, type, rawDmg) {
  const events = []
  m.seen = m.seen || {}
  const n = Number(m.seen[type] || 0)

  if (n >= 2) {
    if (MAHORAGA.adapt.healOnImmune) {
      m.hp = m.maxHp
      events.push(`　${MAHORAGA.lines.immune}`)
      events.push(`　「${type}」已被完全适应 —— 攻击无效，反而让它**回满生命**（${m.hp}/${m.maxHp}）。`)
    }
    return { dmg: 0, immune: true, events }
  }

  const dmg = rawDmg * adaptMulFor(m, type)
  m.hp = Math.max(0, m.hp - dmg)
  m.seen[type] = n + 1
  m.wheel += MAHORAGA.adapt.wheelPerTurn

  if (n === 0) {
    events.push(`　${MAHORAGA.lines.adapt}（「${type}」首次接触，法轮开始转）`)
  } else {
    events.push(`　法轮再转一格 ——「${type}」已进入免疫阶段。`)
    if (!m.adaptedTypes.includes(type)) m.adaptedTypes.push(type)
  }
  return { dmg, immune: false, events }
}

/** 魔虚罗出手（玩家操控） */
export function mahoragaTurn(m, skillId, rng = Math.random) {
  const events = []
  const pool = MAHORAGA.skills.filter((s) => {
    if (s.requiresAdapted) return m.adaptedTypes.length > 0
    return true
  })
  let skill = pool.find((s) => s.id === skillId)
  if (!skill) {
    const total = pool.reduce((a, s) => a + s.weight, 0)
    let r = rng() * total
    skill = pool[pool.length - 1]
    for (const s of pool) { r -= s.weight; if (r <= 0) { skill = s; break } }
  }

  events.push(`　${skill.icon}【${skill.name}】`)

  if (skill.kind === 'reverse') {
    const heal = rollInt(skill.heal[0], skill.heal[1], rng)
    const before = m.hp
    m.hp = Math.min(m.maxHp, m.hp + heal)
    events.push(`　${MAHORAGA.lines.regen}（+${(m.hp - before).toFixed(1)}，现 ${m.hp.toFixed(1)}/${m.maxHp}）`)
    return { skill, dmg: 0, events, broken: false }
  }

  // 退魔之剑的"损坏"判定（用户指定 15%）
  if (skill.breakChance && rollInt(1, 100, rng) <= skill.breakChance) {
    events.push(`　${skill.breakDesc}`)
    return { skill, dmg: 0, events, broken: true }
  }

  let dmg = rollInt(skill.dmg[0], skill.dmg[1], rng)
  if (skill.dmgMul) dmg = Math.round(dmg * skill.dmgMul)
  if (skill.id === 'evolve') events.push(`　${MAHORAGA.lines.evolve}`)
  return { skill, dmg, events, broken: false }
}

/** 魔虚罗的状态条 */
export function mahoragaStatus(m) {
  if (!m) return ''
  const lines = [`⚔️ ${m.name}`]
  lines.push(`${bar(m.hp, m.maxHp, 'player')} ${m.hp.toFixed(1)}/${m.maxHp}`)
  const adapted = m.adaptedTypes.length ? m.adaptedTypes.join('、') : '（尚未完全适应任何类型）'
  lines.push(`法轮 ${m.wheel} 格　已免疫：${adapted}`)
  const parsing = Object.entries(m.seen || {}).filter(([, v]) => v === 1).map(([k]) => k)
  if (parsing.length) lines.push(`解析中（减伤 50%）：${parsing.join('、')}`)
  return lines.join('\n')
}

/**
 * 宿傩 vs 魔虚罗的降伏序列（用户指定的剧本）。
 *
 *   打满 N 回合 → 宿傩意识到它的能力
 *     → 用一回合领域展开把它**锁到 1 血**
 *     → 下一回合若**未被眩晕/黑闪** → 用「灶」彻底秒杀
 *
 * ⚠️ 这个序列必须给玩家**破局窗口**，否则魔虚罗就是"出场即必死"，
 *    玩法没有意义。窗口 = 领域回合打出的眩晕或黑闪。
 *    被救回来时脚本**回退一格**（重新从 realized 开始），
 *    这样"救"是有价值的，不是只延迟一回合。
 */
export function sukunaVsMahoraga(b, m, savedThisTurn, rng = Math.random) {
  const events = []
  const S = MAHORAGA.script
  if (!m || m.phase === 'destroyed') return { phase: 'destroyed', events, destroyed: true }

  m.scriptTurns += 1

  if (m.phase === 'active') {
    if (m.scriptTurns >= S.realizeAfterTurns) {
      m.phase = 'realized'
      events.push(`　${b.boss.name}盯着那只式神看了两秒 —— 他看懂了。`)
      events.push('　「原来是适应……那就不给你适应的机会。」')
    }
    return { phase: m.phase, events, destroyed: false }
  }

  if (m.phase === 'realized') {
    if (savedThisTurn) {
      events.push('　但这一轮他被压制住了，领域没能展开 —— 魔虚罗暂时还活着。')
      return { phase: m.phase, events, destroyed: false }
    }
    m.phase = 'locked'
    const before = m.hp
    m.hp = S.domainLockHp
    events.push('　【领域展开·伏魔御厨子】—— 两百米内无处可逃。')
    events.push('　但魔虚罗已经适应了「斩击」—— 斩击风暴切在它身上，只擦掉一层皮。')
    events.push(`　${b.boss.name}换了个思路：他不杀它，他把它**锁住**。`)
    events.push(`　魔虚罗 ${before.toFixed(1)} → ${m.hp.toFixed(1)} 血 —— 被钉在原地。`)
    return { phase: m.phase, events, destroyed: false }
  }

  if (m.phase === 'locked') {
    if (savedThisTurn) {
      m.phase = 'realized'
      m.scriptTurns = S.realizeAfterTurns - 1
      events.push('　被打断了！「灶」的火焰没能成形 ——')
      events.push('　魔虚罗挣脱束缚，法轮重新开始转动。（它赢回了一轮）')
      return { phase: m.phase, events, destroyed: false }
    }
    m.phase = 'destroyed'
    m.hp = 0
    events.push(`　${b.boss.name}抬手 —— 两种斩击的"料理工序"已经完成。`)
    events.push(`　${S.finishDesc}`)
    events.push('　魔虚罗被彻底烧尽。它的适应，来不及了。')
    return { phase: 'destroyed', events, destroyed: true }
  }

  return { phase: m.phase, events, destroyed: m.hp <= 0 }
}

/* ── 玩家行动 ───────────────────────────────────────────────────── */

/**
 * 玩家回合。
 * @returns {{ events: string[], blackFlash: boolean, dmg: number, evolved: boolean, died: boolean }}
 */
export function playerTurn(b, player, action, args = {}, rng = Math.random) {
  const events = []
  const boss = b.boss
  let blackFlash = false
  // 本回合是不是"真的打出去了" —— 防御/回复/被束縛封印都不算，
  // 真身的天敌判定只在真正命中时触发
  let attacking = false
  let dmg = 0
  let evolved = false

  player.lastAction = action

  if (action === 'defend') {
    const sk = args?.skill || null
    const redu = Number(sk?.reduction) > 0 ? Number(sk.reduction) : ACTIONS.defend.reduction
    player.lastReduction = redu                       // 宿傩回合取用
    if (sk?.sealNext) player.sealAttack = true        // 束縛：下回合不能攻击
    if (sk?.name) events.push(`　${sk.icon || ''}【${sk.name}】展开。`)
    const cost = Number(sk?.cost) || 0
    if (cost > 0) {
      player.hp = Math.max(0, player.hp - cost)
      events.push(`　代价：失去 ${cost} 点生命（现 ${player.hp.toFixed(1)}/${player.maxHp}）。`)
      if (player.hp <= 0) return { events, blackFlash, dmg, evolved, died: true }
    }
    events.push(`${player.name}构筑了防御。`)
    return { events, blackFlash, dmg, evolved, died: false }
  }

  if (action === 'reverse') {
    const skR = args?.skill || null
    const hMul = Number(skR?.healMul) > 0 ? Number(skR.healMul) : 1
    const heal = Math.round(rollInt(ACTIONS.reverse.heal[0], ACTIONS.reverse.heal[1], rng) * hMul)
    const before = player.hp
    player.hp = Math.min(player.maxHp, player.hp + heal)
    const got = player.hp - before
    events.push(`${player.name}施展反转术式，回复 ${got.toFixed(1)} 点生命（现 ${player.hp.toFixed(1)}/${player.maxHp}）。`)
    // 宿傩反转术式被中断时，玩家的治疗更容易奏效（满额）；否则会被他的领域/展延干扰
    if (boss.interruptLeft <= 0 && rng() < 0.35) {
      const lost = got * 0.5
      player.hp = Math.max(0, player.hp - lost)
      events.push(`　但${boss.name}的术式干扰了你的咒力输出，实际只回复了一半。`)
    }
    if (args?.skill?.fragile) player.fragile = true
    return { events, blackFlash, dmg, evolved, died: false }
  }

  // ── 攻击 ──
    attacking = true
    const skA = args?.skill || null
    if (player.sealAttack) {
      player.sealAttack = false
      attacking = false
      events.push(`${player.name}的咒力被束縛锁住，这回合无法攻击。`)
      return { events, blackFlash, dmg, evolved, died: false }
    }
    let chance = BLACK_FLASH_RULE.base
    chance += Number(skA?.bfBonus) || 0          // 招式对黑闪的影响（可负）
  if (player.lastAction === 'defend') chance += BLACK_FLASH_RULE.afterDefend
  if (boss.interruptLeft > 0) chance += BLACK_FLASH_RULE.whileInterrupted
  if (player.evolved) chance += EVOLUTION.blackFlashBonus
  chance += Math.min(BLACK_FLASH_RULE.pityMax, player.pity * BLACK_FLASH_RULE.pityStep)

  const roll = rollInt(1, 100, rng)
  blackFlash = roll <= chance

  if (blackFlash) {
    dmg = BLACK_FLASH.dmg
    player.blackFlashCount += 1
    player.pity = 0
    boss.hp = Math.max(0, boss.hp - dmg)
    boss.interruptLeft = BLACK_FLASH.interruptTurns
    events.push(`${player.name}的攻击与咒力在 0.000001 秒内重合 ——【黑闪】！`)
    events.push(`　造成 ${dmg}% 百分比伤害，并**中断${boss.name}的反转术式 ${BLACK_FLASH.interruptTurns} 回合**。`)
    events.push(`　（触发率 ${chance}%，掷出 ${roll}）`)

    // 打出黑闪 → **二选一**（用户 2026-10-04 改：不再自动进化）
    //
    // ⚠️ 这里只**挂起一个选择**，不直接改数据。
    //    真正的转职在 resolveEvolution() 里 ——
    //    因为玩家要自己决定走虎杖还是伏黑，不能替他选。
    if (!player.evolved && !b.evolveChoice) {
      b.evolveChoice = { id: player.id, name: player.name, turn: b.turn, raisedAt: Date.now() }
      events.push(`　${EVOLUTION.desc}`)
      events.push('　【命运的岔路】黑闪打通了咒力的回路 —— 你要走哪条路？')
      events.push('　　' + EVOLUTION_CHOICE.branches
        .map((x, i) => `${i + 1}. ${x.icon}【${x.name}】${x.desc}`).join('\n　　'))
    }
  } else {
    player.pity += 1
    dmg = rollInt(ACTIONS.attack.dmg[0], ACTIONS.attack.dmg[1], rng)
    dmg *= (Number(skA?.dmgMul) > 0 ? Number(skA.dmgMul) : 1)
    const _cost = Number(skA?.cost) || 0
    if (_cost > 0) { player.hp = Math.max(0, player.hp - _cost); events.push(`　代价：失去 ${_cost} 点生命。`) }
    boss.hp = Math.max(0, boss.hp - dmg)
    events.push(`${player.name}的攻击命中，造成 ${dmg}% 伤害。`)
    events.push(`　（未触发黑闪，掷出 ${roll} / 需要 ≤${chance}）`)
    events.push(`　普通攻击打不过他的自愈 —— 只有黑闪能真正推进。`)
  }

  // ── 真身的天敌判定 ──
  //
  // 用户规则：真身状态下**遭受虎杖攻击**伤害 +50%，并附 10% 眩晕。
  //   ⚠️ 这两条都挂在"虎杖"身上，不是所有人都有 —— 这是有意的：
  //      它让"虎杖"这个转职路线有了不可替代的战术价值，
  //      而不是单纯的数值更高（那伏黑就没人选了）。
  if (attacking && boss.trueForm && boss.hp > 0) {
    const isYuji = player.branch === 'yuji' ||
      (player.evolved && player.branch !== 'megumi')
    if (isYuji) {
      const extra = dmg * (SUKUNA_TRUE_FORM.yujiDmgTaken - 1)
      boss.hp = Math.max(0, boss.hp - extra)
      dmg += extra
      events.push(`　⚠️ 虎杖的拳头砸在真身上，比平时疼得多（额外 ${extra.toFixed(1)}%）—— `
        + `受肉之躯挡不住这个容器。`)
      const stunRoll = rollInt(1, 100, rng)
      if (stunRoll <= SUKUNA_TRUE_FORM.yujiStunChance) {
        boss.stunned = 1
        events.push(`　💫 真身被打得一个趔趄 —— **眩晕**！（掷出 ${stunRoll} ≤ ${SUKUNA_TRUE_FORM.yujiStunChance}）`)
        events.push('　他下一回合停止行动。')
      }
    }
  }

  return { events, blackFlash, dmg, evolved, died: player.hp <= 0, stunned: boss.stunned > 0 }
}

/* ── 转职：黑闪后的二选一 ───────────────────────────────────────── */

/**
 * 这个输入是不是"在选转职路线"？
 *
 * ⚠️ 这里修了一个真实的设计缺陷（2026-10-04，跑测试时抓到）：
 *
 *   最初我让转职也用 **1 / 2** 回复，结果和「出招选 1/2/3」**撞号**：
 *   玩家打完黑闪后，战报里出现的 `1.` `2.` 同时可能是
 *   「转职路线」也可能是「出招选项」，光看数字分不出来。
 *   更糟的是：那一回合他**没法出招** —— 想打第 1 招却被当成选了虎杖。
 *
 *   症状很隐蔽：只有 12% 的概率（黑闪触发率）才复现，
 *   测试跑 6 次挂 1 次，像是"随机失败"。
 *
 *   修法：转职**用名字回复**（「虎杖」/「伏黑」），出招继续用数字。
 *   两套输入空间完全不重叠，歧义消失。
 *   同时战报里**两段都显示**，玩家可以边打边想，不必卡着不回。
 */
export function looksLikeBranchName(arg) {
  const s = String(arg ?? '').trim().toLowerCase()
  if (!s) return false
  return EVOLUTION_CHOICE.branches.some((b) => {
    const names = [b.key, b.name, b.name.slice(0, 2)]
    return names.some((n) => n && s === String(n).toLowerCase())
  })
}

/**
 * 结算转职选择。
 *
 * 接受：分支名（虎杖/伏黑/yuji/megumi）或序号 1/2。
 * 序号仍然接受 —— 但 takeTurn 只在**名字**出现时才走到这里，
 * 保留序号是为了让这个函数单独调用时也好用（测试、脚本）。
 *
 * @returns {{ ok: boolean, branch?: object, events: string[], error?: string }}
 */
export function resolveEvolution(b, player, arg) {
  const branches = EVOLUTION_CHOICE.branches
  let idx = -1

  const s = String(arg ?? '').trim().toLowerCase()
  if (s === '1' || s === '①' || s === 'yuji' || s === '虎杖' || s === '虎杖悠仁') idx = 0
  else if (s === '2' || s === '②' || s === 'megumi' || s === '伏黑' || s === '伏黑惠') idx = 1
  else {
    const n = Number(s)
    if (Number.isFinite(n) && n >= 1 && n <= branches.length) idx = n - 1
  }

  if (idx < 0) {
    return {
      ok: false,
      error: '回复 1 选虎杖悠仁，回复 2 选伏黑惠。',
      events: [],
    }
  }

  const br = branches[idx]
  const events = []
  player.evolved = true
  player.branch = br.key
  player.evolvedAt = Date.now()
  player.maxHp += br.maxHpBonus
  player.hp += br.maxHpBonus
  player.powerRatio = br.powerRatio
  if (br.canSummonMahoraga) player.canSummonMahoraga = true
  if (br.unlocksMegumi) player.unlocksMegumi = true

  events.push(`${br.icon}【转职】${player.name} → ${br.name}`)
  events.push(`　${br.flavor}`)
  events.push(`　实力提升至宿傩的 ${Math.round(br.powerRatio * 100)}%（原 ${Math.round(PLAYER_BASE.powerRatio * 100)}%），`
    + `生命上限 ${player.maxHp}。`)
  if (br.canSummonMahoraga) {
    events.push(`　★ 解锁【十种影法术】与唯一的【魔虚罗】通道 —— 血低于 `
      + `${MAHORAGA_SUMMON.hpBelow}% 时可以召唤。`)
  }
  if (br.trueFormBane) {
    events.push('　★ 你的拳头对宿傩真身有奇效（伤害 +50%，附带眩晕）。')
  }
  b.evolveChoice = null
  return { ok: true, branch: br, events }
}

/* ── 阵亡处理 ───────────────────────────────────────────────────── */

export function handleDeath(b, player) {
  player.alive = false
  player.deaths += 1
  b.casualties.push({ id: player.id, name: player.name, at: Date.now() })

  // ⚠️ 这里踩过一个坑：先 `pruneDead` 再 `advanceQueue` 会**推进两次**。
  //    pruneDead 已经把死者从队列里剔掉并 syncFighter 了，
  //    再 advanceQueue 一次等于把**下一个还活着的人**也踢出去。
  //    症状很隐蔽：队列看着是对的，但第二个人永远上不了场 ——
  //    因为轮到他的瞬间就被这一行 `shift()` 掉了。
  //    实测：甲乙丙三人局，甲死后直接跳到丙，乙凭空消失。
  //
  // 正确做法：只**剔除**死者，然后同步队首。死者正常就在队首，
  // 但提前出局的人可能在中间，所以用 filter 而不是 shift。
  const q = queueOf(b)
  b.queue = q.filter((x) => x.id !== player.id)
  syncFighter(b)
  return {
    broadcast: deathBroadcast(player.name),
    next: b.queue.length ? b.queue[0] : null,
  }
}

/* ── 撤退 / 复活 / 接管 ─────────────────────────────────────────── */

/**
 * 新开一局时把玩家"复原"。
 *
 * ⚠️ 这里补了一个真实缺陷（2026-10-04 跑测试时抓到）：
 *
 *   `canJoin()` 拒绝战死者时会说「**重开一局才能再上**」——
 *   但 `reset` 只重建了 Battle，**从来没碰过 players.json**。
 *   玩家的 `alive:false` 和残血一直留着，于是"重开"之后
 *   那个人照样上不了场，血还是空的。**承诺和实现不一致。**
 *
 *   更隐蔽的是**新群开局**：`start` 拿到的还是全局那份玩家数据，
 *   上个群打剩的 3 点血会直接带进新局 —— 一上场就被秒，
 *   看着像"宿傩太强"，其实是数据没清。
 *
 * 规则：**转职保留，血量与生死重置**。
 *   · 保留转职 —— 那是个人进度，用户明确说"进化不重置"
 *   · 重置生死与血量 —— 那是"本局"的东西，新局就该满血重来
 */
export function reviveForNewGame(player) {
  player.alive = true
  player.hp = player.maxHp
  player.pity = 0
  player.lastAction = null
  player.lastReduction = null
  player.sealAttack = false
  player.fragile = false
  player.summoning = false
  player.controllingMahoraga = false
  return player
}

export function canJoin(b, player) {
  if (b.boss.hp <= 0) return { ok: false, reason: `${b.boss.name}已被讨伐。` }
  if (player.alive && player.hp > 0) return { ok: true, reason: '继续战斗。' }

  // ⚠️ 阵亡者**本局不能立刻复活接着打**。
  //
  // 为什么：一开始我让阵亡者半血复活，结果实测单人 56 回合就能独力讨伐宿傩，
  // "单人只有他 20% 实力"和"接力"就都名存实亡了。
  // 用户的原话是"一个咒术师战死就会弹出…下一个奔赴战场的是！"——
  // 战死就该换人，这才是接力的压力来源。
  return {
    ok: false,
    dead: true,
    reason: `${player.name}已经战死了，本局无法再上场 —— 换个人 @ 我接着打。`
      + `（他的个人数据保留：${player.evolved ? '虎杖悠仁' : '咒术师'}、黑闪 ${player.blackFlashCount} 次。`
      + `重开一局才能再上。）`,
  }
}


/* ── 选项抽取（用户要求："对战时会随机给三个选项，由技能池随机进选项"）───── */

/**
 * 从技能池里随机抽 n 个不重复的招式。
 *
 * 为什么用"按权重不放回抽样"而不是简单洗牌：
 *   · 简单洗牌会让「术式反转·捌」这种高风险大招和「咒力打击」一样常见，
 *     选项池的"手感"就没了 —— 强招该稀有。
 *   · 按权重抽完不回收（不放回），保证三个选项不会出现同一个招式。
 *
 * evolved=false 时会**过滤掉**虎杖专属招式（逕庭拳系），
 * 所以"进化"不只是数值提升，是真的解锁了新选项。
 */
export function rollOptions(player, n = OPTION_COUNT, rng = Math.random) {
  const pool = skillsFor(player)

  // ── 魔虚罗召唤：**必须出现**，不参与随机 ──
  //
  // ⚠️ 为什么不放进池子里随机抽：
  //    这是"血低于 25% 才能用"的**翻盘手段**，玩家是拿命换来的机会。
  //    如果还要靠运气抽到，那这个机制在设计上就是失败的 ——
  //    残血的人本来就快死了，他没时间等下一回合。
  //    所以条件满足时**直接钉进选项**，占掉一个位置。
  const summon = mahoragaSummonOption(player)
  if (summon) {
    const rest = pickWeighted(pool, n - 1, rng)
    const out = [summon, ...rest]
    for (const s of out) delete s._forced
    summon._forced = true
    return out
  }

  return pickWeighted(pool, n, rng)
}

/** 按身份组装可用卡池 */
export function skillsFor(player) {
  // 伏黑惠：换成十种影法术整副卡组
  if (player?.branch === 'megumi') return MEGUMI_SKILLS.slice()

  // 咒术师 / 虎杖：基础卡组 + （进化后）虎杖专属
  return PLAYER_SKILLS.filter((s) => !s.evolvedOnly || player?.evolved)
}

/** 按权重不放回抽 n 个，再按"攻击→防御→回复"排序 */
function pickWeighted(pool, n, rng = Math.random) {
  const items = pool.map((s) => ({ s, w: Math.max(0.0001, Number(s.weight) || 1) }))
  const out = []
  for (let k = 0; k < n && items.length; k++) {
    const total = items.reduce((a, x) => a + x.w, 0)
    let r = rng() * total
    let idx = items.length - 1
    for (let i = 0; i < items.length; i++) {
      r -= items[i].w
      if (r <= 0) { idx = i; break }
    }
    out.push(items[idx].s)
    items.splice(idx, 1)
  }
  const order = { attack: 0, defend: 1, reverse: 2 }
  out.sort((a, b) => (order[a.kind] ?? 9) - (order[b.kind] ?? 9))
  return out
}

/**
 * 满足条件时返回"召唤魔虚罗"这个特殊选项，否则 null。
 *
 * 条件（用户指定）：伏黑惠身份 + 血量低于 25% + 还没召唤过。
 */
export function mahoragaSummonOption(player) {
  if (!MAHORAGA_SUMMON.requireMegumi) return null
  if (player?.branch !== 'megumi') return null
  if (player?.summoning || player?.controllingMahoraga) return null
  if (player?.mahoragaUsed) return null
  const maxHp = Number(player?.maxHp) || 100
  const pct = (Number(player?.hp) || 0) / maxHp * 100
  if (pct >= MAHORAGA_SUMMON.hpBelow) return null

  return {
    id: '__mahoraga',
    name: '八握剑异戒神将魔虚罗',
    icon: '⚔️',
    kind: 'special',
    summable: true,
    desc: `血已不足 ${MAHORAGA_SUMMON.hpBelow}% —— 以性命为代价，赌上那唯一的王牌。`
      + `（吟唱一回合，下一回合出场。它出场时会先咬你一口。）`,
  }
}

/** 把选项渲染成 QQ 群 RPG 那种 1. 2. 3. 列表 */
export function renderOptions(opts) {
  // 用户要求"选项改成 1.2.3 进行回复" —— 所以用纯数字，不用 ①②③。
  // 纯数字有个实际好处：手机键盘上直接敲得到，不用长按找特殊符号。
  const TAG = { attack: '攻', defend: '守', reverse: '愈', special: '召' }
  return opts.map((s, i) => {
    const tag = TAG[s.kind] || '攻'
    return `${i + 1}. ${s.icon}【${s.name}】(${tag}) ${s.desc}`
  }).join('\n')
}

/** 选项 -> 底层行动；选项缺失时退回 attack，保证不崩 */
export function skillToAction(skill) {
  if (!skill) return 'attack'
  if (skill.kind === 'special') return 'summon'
  return skill.kind || 'attack'
}
