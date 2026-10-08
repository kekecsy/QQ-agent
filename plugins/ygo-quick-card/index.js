// 游戏王查卡快车道 —— 插件入口（挂钩子 / 发送 / 留痕）。
//
// ── 为什么必须包 onIncoming，而不是用 5 个 hook ────────────────────────────
//   before-context / before-llm-messages / after-response / before-tool / after-tool
//   这 5 个 hook **都只在"已经排定一次模型会话"之后才触发**。而本插件要做的恰恰是
//   "让这次会话根本不发生" —— 挂在那 5 个钩子上，模型钱已经花了、时间也已经等了，
//   快车道就没有意义了。
//   Orchestrator.prototype.onIncoming 是**每一条**入站消息的必经点（复读机
//   plugins/repeat-echo 同款做法），在这里拦下来才能真的省掉一次模型调用。
//
// ── 顺序是这里最容易错的地方 ──────────────────────────────────────────────
//   复读机是**先调原方法、再跟一句**（旁路增强，改不改都不影响原行为）。
//   我们不能这样：原方法一跑就 scheduleWake 了，等我们判定完再发一条 = 模型回复
//   + 插件回复**两条**。所以本插件的顺序是**反的**：
//     先同步榨查询串（纯字符串，0 延迟）→ 榨不出就立刻放行；
//     榨得出才异步查库，查证期间**先不排唤醒**；查不通/不确定再原样放行。
//   代价是"看起来像查卡"的消息会让模型晚 ~0.3 秒被唤醒 —— 而唤醒本身有 2 秒
//   固定延迟、模型一次往返几十秒，这点延迟无感。
//
// ── 安全边界 ──────────────────────────────────────────────────────────────
//   · 只观察与"提前放行"，绝不改变原方法行为：任何异常都 catch 掉并原样调原方法；
//   · 关掉插件 = 摘钩子，不留任何监听；
//   · 会话在跑/已排队时让路（onlyWhenIdle），避免和模型回复叠成两条；
//   · 消息标已读 + 走 sender.sendTextBatch 完整管道（串行/限频/去重/留档），
//     所以模型后续能看到自己"说过"的卡面，判例追问不会断链。
//
// ⚠️ 本文件在 resources/app 里，应用自动更新会覆盖；装回来即可（配置不受影响）。

import fs from 'node:fs';
import path from 'node:path';
import { format } from 'node:util';
import { Orchestrator } from '../../src/orchestrator.js';
// 主日志（data/logs/qq-agent-*.log）：直答属于"她说了话但没经过模型"的动作，
// 必须留痕，否则事后翻日志只看到一条无来源的发送记录。api.log 只走 console、不落盘。
import { logger } from '../../src/logger.js';
// ⚠️ 数据目录必须问 config.js 要，不能按本文件位置推算：DATA_DIR 会被
// QQ_AGENT_DATA_DIR / QQ_AGENT_PROFILE 重定向（本机就跑在安装根目录的 data/ 下）。
import { DATA_DIR, getConfig, storeConfigForChat } from '../../src/config.js';
import { isAtMe } from '../../src/prompt.js';

const PATCH_KEY = Symbol.for('qq-agent.ygo-quick-card.patch');
const STATE_FILE = path.join(DATA_DIR, 'ygo-quick-card.json');
const STATE_FLUSH_MS = 30_000;

let api = null;
let Logic = null;      // logic.js 的模块命名空间（动态导入，见 setup）
let engine = null;
let lastFlush = 0;

/** 节流写状态文件：看"钩子是否活着 / 拦下过什么"用（answered 一直在涨 = 在干活）。 */
function flushState(force = false) {
  const now = Date.now();
  if (!force && now - lastFlush < STATE_FLUSH_MS) return;
  if (!engine) return;
  lastFlush = now;
  try {
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify(engine.stats(), null, 1), 'utf8');
  } catch { /* 写不出状态不影响直答 */ }
}

/**
 * 引擎的 log/warn 一律**同时**写主日志文件。
 *
 * 为什么必须这样：api.log / api.warn 只走 console，**不落盘**。于是"放行给模型"
 * 这类最需要事后追查的判定，在 data/logs/ 里一个字都找不到 —— 实测 2026-10-05
 * 用户问"阁楼妖咋走的模型"，翻遍日志只能看到"没有记录"，只能靠离线复现才定位到
 * （根因是卡库压根查不到那张卡，不是别名匹配失败）。这类诊断成本必须在源头消掉。
 */
function toLogger(level, args) {
  try {
    logger[level]('ygo-quick-card', format(...args));
  } catch { /* 日志失败不影响判定 */ }
}

function makeEngine() {
  return new Logic.QuickCard({
    settings: () => (api?.config?.() || {}),
    // 走 api.fetch（受 plugin.json 的 web_fetch 权限门控）—— 不是 globalThis.fetch，
    // 这样没声明权限时会被 api 层明确拒绝，而不是"悄悄能联网"。
    fetchImpl: (url, init) => api.fetch(url, init),
    log: (...args) => { toLogger('info', args); api?.log?.(...args); },
    warn: (...args) => { toLogger('warn', args); api?.warn?.(...args); }
  });
}

export async function setup(skillApi) {
  api = skillApi;
  // ⚠️ 动态 + 时间戳导入 logic.js：加载器只给**入口**做了 ?t= 缓存击穿，
  //    静态 import 的 './logic.js' 会一直命中旧模块 —— 改了逻辑热重载后跑的还是老的。
  Logic = await import(`./logic.js?t=${Date.now()}`);
  engine = makeEngine();
}

export function available() {
  return { ok: true };
}

export function activate() {
  const ok = install();
  if (ok) {
    logger.info('ygo-quick-card', '查卡快车道已挂载：onIncoming 钩子（只吃"只问卡面"的请求，0 token）');
  }
}

export function deactivate() {
  uninstall();
}

export function dispose() {
  uninstall();
  engine = null;
}

/** 状态查询能力：给控制台/排障用（不是给模型的工具）。 */
export const providers = {
  'ygo-quick-card.status': () => (engine ? engine.stats() : null)
};

/**
 * 装上钩子。幂等：同一个 prototype 上只包一次，热重载只换 route。
 * 这样即使旧模块实例的 deactivate 没被调到，也不会出现"包两层、判两次"。
 */
function install() {
  const proto = Orchestrator?.prototype;
  if (!proto || typeof proto.onIncoming !== 'function') {
    logger.warn('ygo-quick-card', '拿不到 Orchestrator.prototype.onIncoming，快车道未挂载（应用版本可能变了）');
    return false;
  }
  if (!engine && Logic) engine = makeEngine();

  let rec = proto[PATCH_KEY];
  if (!rec) {
    const original = proto.onIncoming;
    const wrapped = function onIncoming(chatKey, entry = null) {
      try {
        const cur = proto[PATCH_KEY];
        if (cur && typeof cur.route === 'function') return cur.route(this, original, chatKey, entry);
      } catch (error) {
        logger.warn('ygo-quick-card', `快车道判定失败，已放行：${error?.message ?? error}`);
      }
      return original.call(this, chatKey, entry);
    };
    rec = { original, wrapped, route: null };
    proto[PATCH_KEY] = rec;
    proto.onIncoming = wrapped;
  }
  rec.route = route;
  return true;
}

/** 摘钩子：只在确认当前 onIncoming 还是我们那只时才还原。 */
function uninstall() {
  const proto = Orchestrator?.prototype;
  const rec = proto?.[PATCH_KEY];
  if (!rec) return;
  rec.route = null;
  if (proto.onIncoming === rec.wrapped) proto.onIncoming = rec.original;
  delete proto[PATCH_KEY];
}

/**
 * 是不是"在跟她说话"（决定要不要免触发词直接查）。
 * 私聊恒算，群里看 @ 标记 —— 与 resolveContextTier 同口径：有 atMe 标记以标记为准
 * （能区分重名），老存档（atMe === null）才回落到文本包含匹配。
 */
function lenientFor(chatKey, entry) {
  if (String(chatKey).startsWith('private:')) return true;
  if (entry.atMe === true) return true;
  if (entry.atMe === false) return false;
  try {
    const cfg = getConfig();
    return isAtMe(String(entry.text || ''), {
      selfNickname: cfg.persona?.selfNickname || '',
      botName: cfg.persona?.botName || '',
      selfId: cfg.onebot?.selfId || ''
    });
  } catch {
    return false;
  }
}

/** 消息里是否出现"查卡 / 什么效果"这类触发词。 */
function hasIntentWord(text, words) {
  const t = String(text || '');
  return (words || []).some((w) => w && t.includes(w));
}

/**
 * 快车道主判定。
 *
 * 返回值语义：原 onIncoming 返回 void，这里同样不需要返回什么 —— 关键是**决定权在
 * "要不要调 original"**上：命中就自己发完、不排唤醒；没命中就原样交给模型。
 */
function route(orch, original, chatKey, entry) {
  const pass = () => original.call(orch, chatKey, entry);
  try {
    if (!engine || !entry) return pass();
    if (orch?.paused || orch?.aborted) return pass();
    // 会话在跑 / 已排队 → 让路（避免和模型回复叠成两条）
    if (engine.opts().onlyWhenIdle) {
      try {
        if (orch.runningChats?.has?.(chatKey) || orch.pendingWake?.has?.(chatKey)) return pass();
      } catch { /* 内部字段形状变了就当不忙，不阻断 */ }
    }

    const lenient = lenientFor(chatKey, entry);
    // 群里没 @ 到她时的闸门（私聊恒放行，不看这些）：
    //   groupTrigger='any'（默认）→ **两道闸都不设**：免 @、免触发词，群里任何一条
    //       像卡名的消息都试一次查库。安全性不在这里，在下游 —— 对不上卡库就原样
    //       放行给模型，判例词（能不能发动/会不会被无效/连锁…）连 HTTP 都不发。
    //       ⚠️ 它也因此会**先于响应档位**接管：1 档「仅艾特」下，群里非 @ 的查卡
    //       也会被答（模型不跑）。这正是"免 @ 也走快车道"要的效果；不想要就把
    //       设置里的「群里什么时候查卡」改回 at。
    //   groupTrigger='at' → 旧行为：必须 2 档以上，且消息里带触发词。
    if (!lenient && engine.opts().groupTrigger !== 'any') {
      let tier = 4;
      try { tier = Number(storeConfigForChat(chatKey)?.contextTier) || 4; } catch { /* 读不到按全响应 */ }
      if (tier < 2) return pass();
      if (!hasIntentWord(entry.text, engine.opts().intentWords)) return pass();
    }

    // 同步榨查询串（纯字符串）：榨不出就**零延迟**放行，连 HTTP 都不发
    if (!engine.plan(entry.text, { lenient })) return pass();

    // 有戏：异步查证。查证期间先不排唤醒；查不通 / 不确定 / 发送失败 → 原样放行。
    // allowTruncate（去掉尾字再搜一次 + 问"你要的是哪张"）只在**明确在对她说**时开：
    // 私聊、@ 她，或者消息里带了"查卡/什么效果"这类触发词。群里路过的闲聊不开，
    // 否则"阁楼挺好的"这种话也会被追问一张卡。
    const deep = lenient || (() => {
      try { return hasIntentWord(entry.text, engine.opts().intentWords); } catch { return false; }
    })();
    engine.compose(chatKey, entry.text, { lenient, allowTruncate: deep })
      .then((result) => (result ? send(orch, chatKey, entry, result) : false))
      .then((sent) => { if (!sent) pass(); })
      .catch((error) => {
        logger.warn('ygo-quick-card', `快车道异常，已放行：${error?.message ?? error}`);
        try { pass(); } catch { /* original 自己会抛 */ }
      });
    return undefined;
  } catch (error) {
    logger.warn('ygo-quick-card', `快车道判定失败，已放行：${error?.message ?? error}`);
    try { return pass(); } catch { return undefined; }
  }
}

/**
 * 直接发出去（不经过模型）。
 * 走 sender.sendTextBatch 的完整管道：串行 → 限频 → 去重 → **留档（appendSelf）**。
 * 留档这步不能省 —— 模型后续的每一轮都会读到"已读信息"，看不到自己发过的卡面，
 * 用户接着问「那能不能发动」时就会当成一句没头没尾的话。
 */
async function send(orch, chatKey, entry, result) {
  const sender = orch?.sender;
  if (!sender || typeof sender.sendTextBatch !== 'function') {
    logger.warn('ygo-quick-card', '拿不到 sender，放行给模型');
    return false;
  }
  try {
    await sender.sendTextBatch(chatKey, [result.text]);
  } catch (error) {
    // 睡眠闸门 / 发送限频 / 去重都会在这里抛：正常业务拒绝，不当错误刷屏
    logger.warn('ygo-quick-card', `直答没发出去，放行给模型：${error?.message ?? error}`);
    return false;
  }

  // 卡片插图（额外一条）。**发图失败不算失败** —— 文字已经发出去了，这时候再放行给模型
  // 会让"插件的卡面 + 模型的回答"叠成两条，还不如少一张图。
  // 走 sender.sendImage 的完整管道（串行/限频/去重/留档），与文字同一条链路。
  let withImage = false;
  if (result.imageUrl && typeof sender.sendImage === 'function') {
    try {
      await sender.sendImage(chatKey, { url: result.imageUrl }, { note: '' });
      withImage = true;
    } catch (error) {
      logger.warn('ygo-quick-card', `卡图没发出去（卡面已发出，不放行）：${error?.message ?? error}`);
    }
  }

  // 这条消息已经由插件答完了 —— 标已读，免得下一次 wake 把它当"未读信息"再喂给模型
  try {
    orch.store?.markEntryRead?.(chatKey, entry.id);
    orch.emit?.('chat-update', chatKey);
  } catch { /* 标记失败不影响已发出的回复 */ }
  logger.info('ygo-quick-card', `直答 ${chatKey}（${result.kind}${withImage ? '+卡图' : ''}）「${result.query}」：${String(result.text).replace(/\s+/g, ' ').slice(0, 60)}`);
  flushState(true);
  return true;
}

/** 自测用：拿到当前引擎实例。 */
export const internals = { get engine() { return engine; }, install, uninstall, route, lenientFor };
