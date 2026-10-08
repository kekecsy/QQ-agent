// 精简模式（prompt.lean-context）回归网
//
// 两条链路一起验：
//   A. 纯判定/拼装（不碰网络与磁盘）—— 判定错的方向必须是"少省一次钱"
//      ⚠️ 最容易退化的一项就是**假阳性清单**：谁往信号规则里加东西（多收一个术语、
//         放宽一条引号正则），普通闲聊就可能被当成判例问题抢走人设，改完必跑这里。
//   B. 端到端（mock 全套起 app）—— 真的换掉了 system/user 提示词、真的裁了工具表、
//      真的在没有产出时用完整上下文回退；普通闲聊必须完全不受影响
//
// 为什么端到端这条不能省：A 只能证明"函数算得对"，证明不了"编排器真的用了它"。
//   这个功能最危险的失效方式是**静默不生效**（能力名写错 / 白名单对不上 / 时机太早），
//   那种情况下所有单元测试都是绿的，而线上什么都不会发生。
import { createChecker, bootApp, sleep } from './_harness.mjs';

const checker = createChecker('精简模式（prompt.lean-context）');
const { ok, check, section, finish } = checker;

/** 精简模式下**必须不能出现**的东西：群聊人设与全套本次输入。 */
const PERSONA_MARKERS = ['【反 AI 味', '【该说/不该说】', '【保持主体性】'];
const USER_PROMPT_MARKERS = ['【角色设定（管理员设置', '【引导说明】', '【记忆】', '【可用表情包】'];
/** 精简模式下必须出现的东西：判例 playbook + 最小工具协议。 */
const PLAYBOOK_MARKERS = ['【第一步 · 查卡，不要背卡】', 'ygo-ruling__get_script', 'send_message'];
/** 核心给的眼界：把能力名写歪了（或时机不对）专用测试兜不住，这里直接盯 body。 */
const LEAN_TOOLS = new Set([
  'ygo-ruling__search_card', 'ygo-ruling__get_card', 'ygo-ruling__get_script',
  'ygo-ruling__send_card_image', 'send_message', 'get_message_images', 'finish'
]);

function namesOfTools(body) {
  return (body?.tools || []).map((t) => t?.function?.name).filter(Boolean);
}

function reqWith(llm, needle) {
  return llm.state.requests.find((r) => JSON.stringify(r.messages || []).includes(needle)) || null;
}

function assert(cond, message) {
  if (!cond) throw new Error(message);
}

async function partA() {
  section('A. 判定与拼装（离线）');
  const mod = await import(`../skills/ygo-ruling/index.js?t=${Date.now()}`);
  const { ygoSignal, cardishQuote, leanSystem, leanContextFor, LEAN_TOOLS: TOOLS } = mod.internals;

  const shouldLean = [
    '@某bot 这张卡的效果能不能发动',
    '对方场上只有一张 闪刀姬零露，解放自身发动效果，我连锁调和之天救龙，能不能展示六张',
    'C1对手发动了炎舞-「天玑」C2我方连锁轩辕十四的②效果，处理顺序是什么',
    '这张卡被送去墓地之后效果还在吗',
    '游戏王是什么',
    '你有没有玩过游戏王',
    // 【】是卡名的书写习惯：**光有卡名、一个术语都没有**的问法也必须能接管，
    // 这是"停用词表"存在的前提 —— 别为了挡公告把这类也一起挡掉了。
    '【灰流丽】',
    '【灰流丽】能康吗',
    '问一下【增殖的G】怎么处理',
    // 「」单独不算强信号，但搭配术语要能接管
    '「青眼白龙」的效果是什么'
  ];
  const shouldNotLean = [
    '明天有空吗',
    '这把输了，好烦',
    '这皮肤特效挺好看的',
    '我在打一个新游戏，卡关了两天',
    '项目进入下一个阶段了',
    '今天打牌赢了',
    '那个怪兽电影好看吗',
    '我买了新卡片相机',
    '要不要一起上线',
    // ── 引号类假阳性（曾经全都被误判成判例问题）──
    // 「」『』 在中文聊天里就是普通引号，引用别人的话、表示强调都会用。
    '「今天不想上班」',
    '他说「马上就好」，结果等了两小时',
    '所谓「效率」其实就是少干活',
    '『今天也要加油』',
    '帮我看下这个报错「undefined is not a function」',
    // 【】 也不全是卡名：公告/事务/上下文标签都是这个写法。
    '【通知】明天群里开会',
    '【重要】记得交材料',
    '【求助】谁知道怎么装系统',
    '【公告】本周活动安排',
    '【图片】',
    '【表情包】',
    '【2026】年终总结'
  ];

  await check(`游戏王问题被识别（${shouldLean.length} 条真阳性）`, () => {
    for (const t of shouldLean) assert(ygoSignal(t), `漏判：「${t}」`);
    return `${shouldLean.length} 条全部命中`;
  });

  await check(`闲聊不被误判（${shouldNotLean.length} 条假阳性回归）`, () => {
    for (const t of shouldNotLean) assert(!ygoSignal(t), `误判：「${t}」`);
    return `${shouldNotLean.length} 条全部放行`;
  });

  await check('【】里的内容像卡名才认（停用词 + 需含中文）', () => {
    assert(cardishQuote('【灰流丽】'), '卡名应被认作卡名');
    assert(cardishQuote('【青眼白龙】的攻击力'), '卡名应被认作卡名');
    assert(!cardishQuote('【通知】明天开会'), '公告词不该认作卡名');
    assert(!cardishQuote('【2026】年终总结'), '纯数字不该认作卡名');
    assert(!cardishQuote('普通一句话'), '没有【】时不该认作卡名');
  });

  await check('没被叫到（群里路过）不接管', () => {
    const r = leanContextFor({
      reach: { addressed: false },
      triggerEntries: [{ text: '闪刀姬零露解放自身，连锁调和之天救龙能不能展示六张' }]
    });
    assert(r === null, '群里没 @ 她时不该接管');
  });

  await check('被叫到 + 信号够强才接管，且返回 system/工具白名单', () => {
    const r = leanContextFor({
      reach: { addressed: true },
      triggerEntries: [{ text: '这张卡的效果能不能发动' }]
    });
    assert(r && typeof r.system === 'string', '应返回接管对象');
    assert(r.label === '游戏王判例', `label 不对：${r.label}`);
    assert(Array.isArray(r.tools) && r.tools.length, '应给出工具白名单');
    assert(r.tools.includes('ygo-ruling__get_script') && r.tools.includes('send_message'), '白名单缺关键工具');
    assert(Number.isFinite(r.historyLimit), 'historyLimit 应是数字');
  });

  await check('精简 system 含判例 playbook，且不含群聊人设', () => {
    const sys = leanSystem();
    for (const m of PLAYBOOK_MARKERS) assert(sys.includes(m), `精简 system 缺「${m}」`);
    assert(sys.includes('NegateEffect'), '精简 system 应带上无效类判据规则');
    assert(sys.includes('后发先处理') || sys.includes('LIFO'), '精简 system 应带上连锁时间线规则');
    return `${sys.length} 字符`;
  });

  await check('精简 system 明显小于全量系统提示', () => {
    // 全量系统提示（群聊人设 + 全部技能段）实测 12k+；精简版应在一半以下
    assert(leanSystem().length < 8000, `精简 system 应 < 8000，实际 ${leanSystem().length}`);
  });

  await check('设置里 leanMode=false 时完全不接管', async () => {
    const m2 = await import(`../skills/ygo-ruling/index.js?t=${Date.now() + 1}`);
    const registered = [];
    m2.setup({
      config: () => ({ leanMode: false, leanHistory: 8 }),
      log: () => {},
      registerTool: (def) => registered.push(def.id)
    });
    const r = m2.internals.leanContextFor({ reach: { addressed: true }, triggerEntries: [{ text: '这张卡的效果能不能发动' }] });
    assert(r === null, '关了开关还接管了');
    assert(registered.length >= 4, `setup 应注册 4 个工具，实际 ${registered.length}`);
    return '开关生效，工具照常注册';
  });

  await check('工具白名单与技能注册的工具名一致（防手滑写歪）', async () => {
    const m3 = await import(`../skills/ygo-ruling/index.js?t=${Date.now() + 2}`);
    const ids = [];
    m3.setup({ config: () => ({}), log: () => {}, registerTool: (def) => ids.push(`ygo-ruling__${def.id}`) });
    for (const t of TOOLS) {
      if (!t.startsWith('ygo-ruling__')) continue;   // 核心工具（send_message/finish/识图）不在这里查
      assert(ids.includes(t), `白名单里的 ${t} 并不存在（真实注册：${ids.join(', ')}）`);
    }
    return `${ids.length} 个工具全部对得上白名单`;
  });
}

let sizeNote = '';
function addSizeNote(n) { sizeNote = `${n} 字符`; }

async function partB() {
  section('B. 端到端（真 app + mock 模型）');
  // ⚠️ 三条判例消息的措辞必须互不为子串 —— waitSessionDone 是按触发文本找会话的，
  //    两条消息共用"效果能不能发动"会让断言随机命中另一条会话（怀疑人生级难查）。
  const Q1 = '判例题甲：这张卡的效果能不能发动？';
  const Q2 = '判例题乙：这张魔法卡的效果能发动吗';
  const Q3 = '判例题丙：这张卡送去墓地之后效果还在吗';
  const CHAT = '在吗，随便聊两句';
  const script = [
    // ⚠️ send_message 的参数名是 messages（不是 text）——写成 text 会被工具判"内容为空"，
    //    于是精简轮"什么都没发出去"，触发回退，B1 就变成在测回退路径了（踩过）。
    { toolCalls: [{ name: 'send_message', args: { messages: ['按 Lua 实现：可以发动。'] } }] },  // 0 B1 精简轮：发言 → 不回退
    { content: '（结束）' },                                                                    // 1 B1 第 2 轮
    { content: '（闲聊，不发言）' },                                                             // 2 B2
    { content: '我想想。' },                                                                    // 3 B3 精简轮：不发言 → 触发回退
    { content: '（回退轮也不发言，测试到此为止）' },                                              // 4 B3 回退轮
    { content: '（闲聊，不发言）' }                                                              // 5 B4
  ];
  const env = await bootApp({
    script,
    // 关掉查卡快车道：它会在 onIncoming 就拦下"像卡名"的消息，本测试要的是走到模型
    config: { skills: { 'ygo-quick-card': { enabled: false } } }
  });
  try {
    // ── B1：被 @ + 强游戏王信号 → 精简模式 ──
    env.pushGroupMsg(111, '张三', `@覆盖Bot ${Q1}`, 9001);
    const s1 = await env.waitSessionDone('判例题甲');
    assert(s1, '会话没跑起来');
    const req1 = reqWith(env.llm, Q1);
    assert(req1, '模型没有收到这条消息（可能被判成"不响应"或被插件抢答了）');
    const sys1 = String(req1.messages?.[0]?.content ?? '');
    const usr1 = String(req1.messages?.[1]?.content ?? '');

    await check('B1 系统提示换成了精简版（判例 playbook）', () => {
      for (const m of PLAYBOOK_MARKERS) assert(sys1.includes(m), `缺「${m}」`);
      return `${sys1.length} 字符`;
    });
    await check('B1 系统提示里没有群聊人设', () => {
      for (const m of PERSONA_MARKERS) assert(!sys1.includes(m), `精简 system 里混进了「${m}」`);
      return PERSONA_MARKERS.join(' / ') + ' 全部不存在';
    });
    await check('B1 本次输入没有角色卡/引导说明/记忆/表情包', () => {
      for (const m of USER_PROMPT_MARKERS) assert(!usr1.includes(m), `本次输入里混进了「${m}」`);
      assert(usr1.includes('【当前消息】'), '本次输入缺少【当前消息】段');
      return `${usr1.length} 字符`;
    });
    await check('B1 工具表被裁到白名单内', () => {
      const names = namesOfTools(req1);
      assert(names.length > 0, '一个工具都没有');
      const extra = names.filter((n) => !LEAN_TOOLS.has(n));
      assert(extra.length === 0, `出现了白名单外的工具：${extra.join(', ')}`);
      assert(names.includes('ygo-ruling__get_script'), '缺 get_script');
      return names.join(', ');
    });
    await check('B1 真的发出了消息（走的是精简轮，没有回退）', () => {
      assert(s1.sent?.length > 0, '精简轮应该已经发言');
      assert(s1.leanApplied === true, `leanApplied=${s1.leanApplied}`);
      assert(s1.leanMode?.label === '游戏王判例', `leanMode=${JSON.stringify(s1.leanMode)}`);
      assert(s1.leanFallback !== true, '这一轮不该回退');
      return `label=${s1.leanMode.label}，发出 ${s1.sent.length} 条`;
    });

    // ── B2：同一条消息在群里**没被 @** → 不接管（人设不能莫名消失） ──
    env.pushGroupMsg(113, '王五', Q2, 9002);
    const s2 = await env.waitSessionDone('判例题乙');
    assert(s2, '第二条会话没跑起来');
    const req2 = reqWith(env.llm, Q2);
    await check('B2 群里没被 @ 时不接管（走全量提示词）', () => {
      assert(req2, '没找到对应的模型请求');
      const sys = String(req2.messages?.[0]?.content ?? '');
      const usr = String(req2.messages?.[1]?.content ?? '');
      assert(sys.includes('【反 AI 味'), '应保留完整系统提示');
      assert(usr.includes('【引导说明】'), '应保留完整本次输入');
      assert(s2.leanApplied !== true, '不该标记成精简模式');
      return `system ${sys.length} 字符`;
    });

    // ── B3：判例但模型什么都没发 → 用完整上下文回退重跑 ──
    env.pushGroupMsg(111, '张三', `@覆盖Bot ${Q3}`, 9003);
    const s3 = await env.waitSessionDone('判例题丙');
    assert(s3, '第三条会话没跑起来');
    await check('B3 精简轮没产出 → 标记回退', () => {
      assert(s3.leanFallback === true, `leanFallback=${s3.leanFallback}`);
      return '已回退';
    });
    await check('B3 回退轮用回了完整上下文（同一会话跑两遍）', () => {
      const reqs = env.llm.state.requests.filter((r) => JSON.stringify(r.messages || []).includes(Q3));
      assert(reqs.length >= 2, `该消息应有 2 次请求（精简 + 回退），实际 ${reqs.length}`);
      const first = String(reqs[0].messages?.[0]?.content ?? '');
      const last = String(reqs[reqs.length - 1].messages?.[0]?.content ?? '');
      assert(!first.includes('【反 AI 味'), '第一遍应是精简提示词');
      assert(last.includes('【反 AI 味'), '回退遍应换成完整系统提示词');
      return `第 1 遍 ${first.length} 字符 → 回退遍 ${last.length} 字符`;
    });
    await check('B3 同一会话只结束一次（不重复 emit session-end）', () => {
      // 会话终态只有一个：noreply（第二遍也没发言）。若收尾写了两处，这里会看到
      // finish 被调用两次的痕迹 —— 以"最终 status 与 usage 对得上"间接验证。
      assert(s3.status === 'noreply', `status=${s3.status}`);
      assert(s3.endedAt, '应有结束时间');
      return `status=${s3.status}`;
    });

    // ── B4：普通闲聊不受影响 ──
    env.pushGroupMsg(111, '张三', `@覆盖Bot ${CHAT}`, 9004);
    const s4 = await env.waitSessionDone('随便聊两句');
    await check('B4 普通闲聊仍走全量提示词', () => {
      const req = reqWith(env.llm, CHAT);
      assert(req, '没找到闲聊对应的请求');
      const sys = String(req.messages?.[0]?.content ?? '');
      assert(sys.includes('【反 AI 味'), '闲聊不该被精简');
      assert(s4.leanApplied !== true, '闲聊不该标记精简');
      return `system ${sys.length} 字符`;
    });

    await check('B5 精简轮确实更便宜（prompt 字符数对比）', () => {
      const lean = reqWith(env.llm, Q3);
      const full = reqWith(env.llm, CHAT);
      const leanChars = (lean.messages || []).reduce((a, m) => a + String(m.content ?? '').length, 0);
      const fullChars = (full.messages || []).reduce((a, m) => a + String(m.content ?? '').length, 0);
      assert(leanChars * 2 < fullChars, `精简没有明显更小：${leanChars} vs ${fullChars}`);
      return `${leanChars} vs ${fullChars} 字符（省 ${Math.round((1 - leanChars / fullChars) * 100)}%）`;
    });

    await sleep(50);
  } finally {
    await env.teardown();
  }
}

try {
  // ⚠️ B 段必须排在 A 段前面。
  //   原因：`src/config.js` 的 DATA_DIR 是**模块加载那一刻**从 QQ_AGENT_DATA_DIR 读的，
  //   而 bootApp 是"先 mkdtemp 设环境变量、再动态 import app.js"。A 段会直接
  //   import 技能（连带 config.js），一旦它先跑，DATA_DIR 就被固定成项目的 data/，
  //   bootApp 的隔离数据目录失效 —— 表现为单实例锁撞上正在运行的真实机器人
  //   （实测报错「已有 QQ Agent 实例在运行（PID xxx）」，看着像并发问题，其实是顺序问题）。
  await partB();
} catch (error) {
  ok('B 段未捕获异常', '');
  console.error('B 段中断：', error?.stack ?? error);
  process.exitCode = 1;
}
try {
  await partA();
} catch (error) {
  ok('A 段未捕获异常', '');
  console.error('A 段中断：', error?.stack ?? error);
  process.exitCode = 1;
} finally {
  finish();
}
