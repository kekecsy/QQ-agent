#!/usr/bin/env node
/**
 * 判例探针 —— 用**真实模型**跑 `test/ygo-judge-cases.json` 里的判例，看模型最终发给用户的
 * 是什么，并对"结论关键词 / 关键工具调用 / 脚本判据是否被引用"做粗判。
 *
 *   node scripts/ygo-judge-probe.mjs                 # 跑全部用例
 *   node scripts/ygo-judge-probe.mjs --case chain-field-empty
 *   node scripts/ygo-judge-probe.mjs --limit 1       # 只跑前 N 条（省额度）
 *   node scripts/ygo-judge-probe.mjs --verbose       # 打印每轮工具调用明细
 *
 * ⚠️ 会产生真实模型调用费用：每条用例约 3~5 次调用。所以**不挂 `npm test`**，
 *    只在改了技能提示词、想验证"模型行为有没有变好"时手动跑。
 *
 * 判定口径（故意做得保守）：
 *   - `mustCallTools` 缺一即 FAIL（例如判例题没取脚本 = 违反提示词硬规则）；
 *   - `mustInclude` 是"最终回复里必须出现"的字符串；
 *   - `mustNotInclude` 出现即 FAIL（明显错误的结论措辞）；
 *   - `mustMention`（脚本判据名）缺失只记 WARN —— 模型可能用中文描述同一件事。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadPlugins } from '../src/plugin-loader.js';
import { skillManager } from '../src/skills/manager.js';
import { buildSystemPrompt } from '../src/prompt.js';
import { buildToolDefs, toOpenAiTools, executeTool } from '../src/tools.js';
import { chatCompletionWithRetry } from '../src/llm.js';
import { getConfig } from '../src/config.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CASE_FILE = path.join(ROOT, 'test', 'ygo-judge-cases.json');
const MAX_ROUNDS = 8;

const HELP = `用法：node scripts/ygo-judge-probe.mjs [选项]

用真实模型跑判例用例，输出模型最终发出的消息并做粗判。
  --case <id>   只跑指定用例
  --limit <N>   只跑前 N 条
  --verbose     打印每轮工具调用明细
  --dry         只组装提示词、不调用模型（检查规则是否进了系统提示词）
  --help        显示本帮助`;

function parseArgs(argv) {
  const out = { caseId: null, limit: null, verbose: false, dry: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--help' || a === '-h') { console.log(HELP); process.exit(0); }
    if (a === '--verbose') { out.verbose = true; continue; }
    if (a === '--dry') { out.dry = true; continue; }
    if (a === '--case') { out.caseId = argv[++i]; continue; }
    if (a === '--limit') { out.limit = Number(argv[++i]); continue; }
    throw new Error(`未知参数：${a}`);
  }
  return out;
}

/** 加载 skills/ 与 plugins/，激活所有启用项（与 app.reloadSkills 同口径）。 */
async function bootSkills() {
  await loadPlugins({ log: () => {} });
  for (const st of skillManager.list()) {
    if (st.enabled && st.loaded) { try { skillManager.activate(st.id); } catch { /* 单个技能失败不影响探针 */ } }
  }
}

/** 只保留技能工具 + 发消息工具；sender 是假的，只把消息录下来。 */
function makeCtx(sent) {
  return {
    chatKey: 'private:probe',
    sender: {
      async sendTextBatch(_chatKey, messages) {
        const s = messages.map((m) => ({ text: typeof m === 'string' ? m : String(m?.text ?? m) }));
        sent.push(...s.map((x) => x.text));
        // ⚠️ 真 sender 一定返回 { sent, failed }；少了 failed 会让 send_message 自己抛错
        return { sent: s, failed: [] };
      },
      async sendImage() { return { ok: true }; }
    },
    session: { id: 'probe', sent: [] },
    emit: () => {},
    log: () => {}
  };
}

async function runCase(defs, tools, c, opt, timeoutMs) {
  const sent = [];
  const called = [];
  const ctx = makeCtx(sent);
  const messages = [
    { role: 'system', content: buildSystemPrompt({}) },
    { role: 'user', content: c.question }
  ];
  let answered = false;
  let aborted = null;
  try {
    for (let round = 1; round <= MAX_ROUNDS && !answered; round += 1) {
      const t0 = Date.now();
      const res = await chatCompletionWithRetry({
        messages, tools, skillContext: { messages }, signal: AbortSignal.timeout(timeoutMs)
      });
      const msg = res.message ?? {};
      const calls = msg.tool_calls || [];
      if (opt.verbose && msg.content) console.log(`    [轮 ${round}] 正文: ${String(msg.content).slice(0, 200)}`);
      if (!calls.length) break;
      messages.push({ role: 'assistant', content: msg.content || '', tool_calls: calls });
      for (const call of calls) {
        const name = call.function?.name;
        called.push(name);
        const r = await executeTool(defs, ctx, name, call.function?.arguments);
        const text = typeof r.content === 'string' ? r.content : JSON.stringify(r.content);
        if (opt.verbose) console.log(`    [轮 ${round}] ${name} → ${r.isError ? '错误' : 'OK'} ${text.slice(0, 120).replace(/\n/g, ' ')}`);
        if (name === 'send_message' && !r.isError) answered = true;
        messages.push({ role: 'tool', tool_call_id: call.id, content: text.slice(0, 20000) });
      }
      if (opt.verbose) console.log(`    [轮 ${round}] 耗时 ${((Date.now() - t0) / 1000).toFixed(0)}s`);
    }
  } catch (error) {
    // ⚠️ NVIDIA 端点偶发极慢（单轮 90s+，个别请求更久）。超时是**环境问题**，不是提示词问题，
    //    记下来继续跑下一条，别让一条用例把整轮探针打断。
    aborted = error?.message ?? String(error);
  }
  return { sent, called, aborted };
}

function grade(c, { sent, called }) {
  const text = sent.join('\n');
  const fails = [];
  const warns = [];
  if (!sent.length) fails.push('没有调用 send_message —— 真实环境里用户收不到回答');
  for (const t of c.mustCallTools || []) {
    if (!called.includes(t)) fails.push(`没有调用必需工具 ${t}`);
  }
  for (const s of c.mustInclude || []) {
    if (!text.includes(s)) fails.push(`最终回复缺少「${s}」`);
  }
  for (const s of c.mustNotInclude || []) {
    if (text.includes(s)) fails.push(`最终回复出现错误措辞「${s}」`);
  }
  for (const s of c.mustMention || []) {
    if (!text.includes(s)) warns.push(`回复没直接引用脚本判据「${s}」（可能只是用中文描述，人工确认）`);
  }
  return { fails, warns };
}

async function main() {
  const opt = parseArgs(process.argv.slice(2));
  const cases = JSON.parse(fs.readFileSync(CASE_FILE, 'utf8'));
  if (!Array.isArray(cases) || !cases.length) throw new Error('用例集为空');

  await bootSkills();
  const names = new Set(cases.flatMap((c) => c.mustCallTools || []).concat(['send_message']));
  const defs = buildToolDefs().filter((d) => names.has(d.id));
  const tools = toOpenAiTools(defs);
  const system = buildSystemPrompt({});
  console.log(`系统提示词 ${system.length} 字符 | 工具表 ${defs.map((d) => d.id).join(', ')}`);

  if (opt.dry) {
    for (const k of ['连锁判定必须按', '后发先处理', 'NegateEffect']) {
      console.log(`  ${system.includes(k) ? '✓' : '✗'} 含规则片段「${k}」`);
    }
    return;
  }

  const cfg = getConfig();
  if (!String(cfg?.api?.baseUrl || '').trim()) throw new Error('还没配置模型 API，无法跑探针');
  // 单轮超时读技能/全局配置（NVIDIA 端点实测单轮 30~55s，偶发更久）
  const timeoutMs = Number(cfg?.api?.timeoutMs) > 0 ? Number(cfg.api.timeoutMs) : 300000;
  console.log(`⚠️ 会发起真实模型调用（每条用例 3~5 次，单轮超时 ${Math.round(timeoutMs / 1000)}s）。\n`);

  let selected = cases;
  if (opt.caseId) selected = cases.filter((c) => c.id === opt.caseId);
  else if (opt.limit) selected = cases.slice(0, opt.limit);
  if (!selected.length) throw new Error(`没有匹配的用例：${opt.caseId ?? ''}`);

  let failCount = 0;
  let abortCount = 0;
  for (const c of selected) {
    console.log(`\n==================== ${c.id} ====================`);
    console.log(`用例：${c.note}`);
    const result = await runCase(defs, tools, c, opt, timeoutMs);
    console.log(`工具调用序列：${result.called.join(' → ') || '（无）'}`);
    console.log('---------- 模型实际发出的消息 ----------');
    if (!result.sent.length) console.log('（无）');
    result.sent.forEach((t, i) => console.log(`[${i + 1}] ${t}`));
    console.log('---------- 判定 ----------');
    if (result.aborted) {
      abortCount += 1;
      console.log(`  SKIP 端点超时/中断，未能判定（${result.aborted}）—— 环境问题，重跑即可`);
      continue;
    }
    const { fails, warns } = grade(c, result);
    for (const w of warns) console.log(`  WARN ${w}`);
    if (fails.length) { failCount += 1; for (const f of fails) console.log(`  FAIL ${f}`); }
    else console.log('  PASS');
  }

  console.log(`\n==== 汇总：${selected.length} 条用例，${failCount} 条 FAIL${abortCount ? `，${abortCount} 条超时未判定` : ''} ====`);
  if (failCount) process.exitCode = 1;
}

main().catch((e) => { console.error('[probe] 失败：', e?.message ?? e); process.exit(1); });
