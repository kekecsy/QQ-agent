// 账号池（skills/account-pool）离线回归测试。
//
// 为什么需要它：这个技能在"主调用路径"上决定**每一次模型请求打给谁**。
// 它坏了不会报错，只会表现为"某把 Key 被反复用、其它闲置"或"拿不到 Key 时
// 悄悄退回主 Key 假装在均衡" —— 两种都极难在群里发现。规则必须有网。
//
// 全部离线：不发请求，只测挑选/解析/归一/去重/冷却这些纯逻辑。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import * as pool from '../skills/account-pool/index.js';

const { internals } = pool;
let pass = 0;
const failures = [];

function check(name, fn) {
  try {
    fn();
    pass += 1;
    console.log('  ✓', name);
  } catch (error) {
    failures.push(`${name}\n      ${error.message}`);
    console.log('  ✗', name, '→', error.message);
  }
}

/** 装一个假的配置源；每个用例自己 reset 统计。 */
let current = {};
pool.setup({ config: () => current, log: () => {} });
function useConfig(cfg) {
  current = cfg;
  pool.resetStats();
}

const NV = 'https://integrate.api.nvidia.com/v1';
const MODEL = 'deepseek-ai/deepseek-v4.1-flash';

function acc(i, extra = {}) {
  return {
    id: `acc_${i}`,
    name: `key${i}`,
    baseUrl: NV,
    key: `nvapi-test-${i}`,
    model: MODEL,
    enabled: true,
    ...extra
  };
}

// ══ 一、round-robin：同款免费 Key 的均匀轮转 ═══════════════════════════
console.log('\n=== 一、round-robin 轮转 ===');

check('三把 Key 严格 1→2→3→1→2→3（模拟成功回报）', () => {
  useConfig({ strategy: 'round-robin', accounts: [acc(1), acc(2), acc(3)] });
  const seen = [];
  for (let i = 0; i < 6; i++) {
    const picked = pool.pickAccount();
    assert.ok(picked, `第 ${i + 1} 次没挑到账号`);
    seen.push(picked.id);
    pool.recordLatency(picked.id, 1000);   // 模拟 llm.js 的成功回报
  }
  assert.deepEqual(seen, ['acc_1', 'acc_2', 'acc_3', 'acc_1', 'acc_2', 'acc_3']);
});

check('失败也推进轮转（否则一把坏 Key 会被反复选中）', () => {
  useConfig({ strategy: 'round-robin', accounts: [acc(1), acc(2)] });
  const a = pool.pickAccount();
  pool.recordError(a.id, false);           // 超时/5xx：不冷却，但也要记 lastUsed
  const b = pool.pickAccount();
  assert.notEqual(b.id, a.id, '失败后必须换下一个账号');
});

check('并发派发（feedback 还没回来）不会连续挑同一个账号', () => {
  useConfig({ strategy: 'round-robin', accounts: [acc(1), acc(2)] });
  const a = pool.pickAccount();
  const b = pool.pickAccount();            // 第一个请求还在飞，feedback 尚未回报
  assert.notEqual(a.id, b.id, '派发序号必须在挑中那一刻写入，否则并发请求会重复挑同一个');
  const c = pool.pickAccount();
  assert.notEqual(b.id, c.id);
});

check('同毫秒内的连续挑选也必须轮转（时间戳排序会在这里退化）', () => {
  // 回归：原来用 Date.now() 排序，同毫秒内时间戳相等 → reduce 停在第一个
  // → 两把 Key 的池子变成"只用第一把"。现在按派发序号排序。
  useConfig({ strategy: 'round-robin', accounts: [acc(1), acc(2)] });
  const seen = [];
  for (let i = 0; i < 6; i++) { const p = pool.pickAccount(); seen.push(p.id); pool.recordLatency(p.id, 1); }
  assert.deepEqual(seen, ['acc_1', 'acc_2', 'acc_1', 'acc_2', 'acc_1', 'acc_2']);
});

check('停用的账号不参与轮转', () => {
  useConfig({ strategy: 'round-robin', accounts: [acc(1, { enabled: false }), acc(2)] });
  for (let i = 0; i < 4; i++) {
    assert.equal(pool.pickAccount().id, 'acc_2');
    pool.recordLatency('acc_2', 1000);
  }
});

// ══ 二、限流冷却 ═══════════════════════════════════════════════════════
console.log('\n=== 二、限流冷却 ===');

check('429 → 该账号立刻退出池子', () => {
  useConfig({ strategy: 'round-robin', cooldownMs: 60000, accounts: [acc(1), acc(2)] });
  pool.recordError('acc_1', true);
  for (let i = 0; i < 4; i++) {
    assert.equal(pool.pickAccount().id, 'acc_2', '冷却中的账号不该被选中');
    pool.recordLatency('acc_2', 1000);
  }
});

check('冷却期内后续的普通错误不会把限流标记冲掉', () => {
  useConfig({ strategy: 'round-robin', cooldownMs: 60000, accounts: [acc(1), acc(2)] });
  pool.recordError('acc_1', true);          // 429
  pool.recordError('acc_1', false);         // 几秒后同账号一次超时
  const v = internals.snapshot().accounts.find((a) => a.id === 'acc_1');
  assert.equal(v.coolingDown, true, '粘性丢失会让冷却中的账号被重新投用，继续撞 429');
});

check('冷却窗口过期后自动恢复（不会被永久拉黑）', () => {
  useConfig({ strategy: 'round-robin', cooldownMs: 1, accounts: [acc(1), acc(2)] });
  pool.recordError('acc_1', true);
  const t = Date.now() + 50;
  const realNow = Date.now;
  Date.now = () => t;                        // 快进
  try {
    const ids = new Set();
    for (let i = 0; i < 2; i++) { const p = pool.pickAccount(); ids.add(p.id); pool.recordLatency(p.id, 1); }
    assert.ok(ids.has('acc_1'), '冷却窗口过了就该能重新接活');
  } finally {
    Date.now = realNow;
  }
});

check('全池冷却时返回 null（调用方回退自身配置，而不是死等）', () => {
  useConfig({ strategy: 'round-robin', cooldownMs: 60000, accounts: [acc(1), acc(2)] });
  pool.recordError('acc_1', true);
  pool.recordError('acc_2', true);
  assert.equal(pool.pickAccount(), null);
});

// ══ 三、外部端点文件 ═══════════════════════════════════════════════════
console.log('\n=== 三、外部端点文件（endpoints.nvidia.json 那种）===');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pool-test-'));
const writeTmp = (name, obj) => {
  const p = path.join(tmpDir, name);
  fs.writeFileSync(p, JSON.stringify(obj, null, 2), 'utf8');
  return p;
};

check('形状 ①：endpoints[] —— URL 归一成 /v1（否则会拼出双 /chat/completions）', () => {
  const p = writeTmp('a.json', {
    endpoints: [
      { name: 'nv-1', url: `${NV}/chat/completions`, model: MODEL, key: 'k1' },
      { name: 'nv-2', url: `${NV}/v1/`.replace('/v1/v1/', '/v1/'), model: MODEL, key: 'k2' }
    ]
  });
  const { accounts, problems } = internals.parseEndpointFile(JSON.parse(fs.readFileSync(p, 'utf8')));
  assert.equal(problems.length, 0, problems.join('；'));
  for (const a of accounts) assert.equal(a.baseUrl, NV, `baseUrl 应归一为 ${NV}，实际 ${a.baseUrl}`);
});

check('形状 ②：keys[] + api_base —— 每一把 Key 成为一个端点', () => {
  const p = writeTmp('b.json', {
    api_base: NV,
    model: MODEL,
    keys: [{ index: 1, key: 'k1' }, { index: 2, key: 'k2' }, { index: 3, key: 'k3' }]
  });
  const { accounts, problems } = internals.parseEndpointFile(JSON.parse(fs.readFileSync(p, 'utf8')));
  assert.equal(problems.length, 0, problems.join('；'));
  assert.equal(accounts.length, 3);
  assert.deepEqual(accounts.map((a) => a.baseUrl), [NV, NV, NV]);
  assert.deepEqual(accounts.map((a) => a.model), [MODEL, MODEL, MODEL]);
});

check('文件端点与手工账号同 (baseUrl, key) 时去重（同一把 Key 不该被算两次）', () => {
  const p = writeTmp('c.json', {
    endpoints: [
      { name: 'dup', url: `${NV}/chat/completions`, key: 'nvapi-test-1' },
      { name: 'new', url: `${NV}/chat/completions`, key: 'nvapi-test-9' }
    ]
  });
  useConfig({ strategy: 'round-robin', endpointsFile: p, accounts: [acc(1)] });
  const list = internals.allAccounts();
  assert.equal(list.length, 2, `应为 手工1 + 文件1，实际 ${list.length}`);
  assert.deepEqual(list.map((a) => a.id), ['acc_1', 'file:new']);
});

check('文件里的端点也能参与轮转', () => {
  const p = writeTmp('d.json', {
    endpoints: [
      { name: 'f1', url: `${NV}/chat/completions`, key: 'k1' },
      { name: 'f2', url: `${NV}/chat/completions`, key: 'k2' }
    ]
  });
  useConfig({ strategy: 'round-robin', endpointsFile: p, accounts: [] });
  const seen = [];
  for (let i = 0; i < 4; i++) { const x = pool.pickAccount(); seen.push(x.id); pool.recordLatency(x.id, 1); }
  assert.deepEqual(seen, ['file:f1', 'file:f2', 'file:f1', 'file:f2']);
});

// ══ 四、Key 解析与"绝不静默复用主 Key" ════════════════════════════════
console.log('\n=== 四、Key 解析 ===');

check('优先级：明文 key > key_env > source 文件', () => {
  const keyFile = path.join(tmpDir, 'k.txt');
  fs.writeFileSync(keyFile, 'from-file-key\n', 'utf8');
  process.env.POOL_TEST_ENV = 'from-env-key';
  try {
    assert.equal(internals.resolveKey({ key: 'inline', key_env: 'POOL_TEST_ENV', source: keyFile }).from, 'inline');
    assert.equal(internals.resolveKey({ key_env: 'POOL_TEST_ENV', source: keyFile }).key, 'from-env-key');
    assert.equal(internals.resolveKey({ source: keyFile }).key, 'from-file-key');
  } finally {
    delete process.env.POOL_TEST_ENV;
  }
});

check('source 支持 JSON 形态的 key 文件', () => {
  const p = path.join(tmpDir, 'k.json');
  fs.writeFileSync(p, JSON.stringify({ api_key: 'json-key' }), 'utf8');
  assert.equal(internals.resolveKey({ source: p }).key, 'json-key');
});

check('拿不到 Key 的端点：标记不可用 + 给原因，且**绝不**参与挑选', () => {
  const p = writeTmp('e.json', {
    endpoints: [
      { name: 'noenv', url: `${NV}/chat/completions`, key_env: 'THIS_ENV_DOES_NOT_EXIST' },
      { name: 'ok', url: `${NV}/chat/completions`, key: 'real' }
    ]
  });
  useConfig({ strategy: 'round-robin', endpointsFile: p, accounts: [] });
  const snap = internals.snapshot();
  const bad = snap.accounts.find((a) => a.id === 'file:noenv');
  assert.equal(bad.eligible, false);
  assert.match(bad.reason, /环境变量 THIS_ENV_DOES_NOT_EXIST 未设置/, bad.reason);
  for (let i = 0; i < 4; i++) {
    const picked = pool.pickAccount();
    assert.equal(picked.id, 'file:ok', '拿不到 Key 的端点一旦被选中，就会悄悄用主 Key —— 那等于没均衡');
    pool.recordLatency(picked.id, 1);
  }
});

check('池里全是没有 Key 的端点时返回 null（宁可回退，也不假装在均衡）', () => {
  const p = writeTmp('f.json', {
    endpoints: [{ name: 'x', url: `${NV}/chat/completions`, key_env: 'NOPE_MISSING' }]
  });
  useConfig({ strategy: 'round-robin', endpointsFile: p, accounts: [] });
  assert.equal(pool.pickAccount(), null);
  assert.equal(pool.available().ok, false);
  assert.match(pool.available().reason, /拿不到 Key/);
});

check('文件不存在 / JSON 坏掉都不抛错，只在快照里报问题', () => {
  useConfig({ strategy: 'round-robin', endpointsFile: path.join(tmpDir, 'nope.json'), accounts: [] });
  assert.equal(pool.pickAccount(), null);
  assert.match(internals.snapshot().file.problems[0], /不存在/);

  const broken = path.join(tmpDir, 'broken.json');
  fs.writeFileSync(broken, '{ not json', 'utf8');
  useConfig({ strategy: 'round-robin', endpointsFile: broken, accounts: [] });
  assert.equal(pool.pickAccount(), null);
  assert.match(internals.snapshot().file.problems[0], /解析失败/);
});

check('改文件即时生效（按 mtime+size 重新加载，不用重启）', () => {
  const p = writeTmp('g.json', {
    endpoints: [{ name: 'one', url: `${NV}/chat/completions`, key: 'k1' }]
  });
  useConfig({ strategy: 'round-robin', endpointsFile: p, accounts: [] });
  assert.equal(internals.allAccounts().length, 1);
  // 写一个新版本（内容长度必须变，避免同毫秒内 mtime+size 撞车）
  fs.writeFileSync(p, JSON.stringify({
    endpoints: [
      { name: 'one', url: `${NV}/chat/completions`, key: 'k1' },
      { name: 'two', url: `${NV}/chat/completions`, key: 'k2' }
    ]
  }, null, 2), 'utf8');
  assert.equal(internals.allAccounts().length, 2, '加了一把 Key 之后应当立刻看到');
});

// ══ 五、不采纳文件里的 extra_body ═════════════════════════════════════
console.log('\n=== 五、extra_body 刻意不采纳 ===');

check('文件里的 response_format/temperature 不会被带进账号（那是打标调的形状）', () => {
  const p = writeTmp('h.json', {
    endpoints: [{
      name: 'tag', url: `${NV}/chat/completions`, key: 'k1',
      extra_body: { chat_template_kwargs: { thinking: false }, response_format: { type: 'json_object' }, temperature: 0 }
    }]
  });
  const { accounts } = internals.parseEndpointFile(JSON.parse(fs.readFileSync(p, 'utf8')));
  const keys = Object.keys(accounts[0]);
  assert.ok(!keys.includes('extra_body'), '不能把 extra_body 原样带进账号');
  assert.ok(!keys.includes('temperature'), 'temperature 由 QQ Agent 自己管');
  assert.ok(!keys.includes('response_format'), 'response_format=json_object 会让正常回复变成 JSON');
});

// ══ 六、weighted 策略仍然可用 ═════════════════════════════════════════
console.log('\n=== 六、weighted 策略 ===');

check('weighted：延迟低的被选中概率更高，但慢的不会被饿死', () => {
  useConfig({ strategy: 'weighted', minWeight: 0.1, accounts: [acc(1), acc(2)] });
  // 造出明显的延迟差：acc_1 快 100ms，acc_2 慢 2000ms
  for (let i = 0; i < 40; i++) { pool.recordLatency('acc_1', 100); pool.recordLatency('acc_2', 2000); }
  const counts = { acc_1: 0, acc_2: 0 };
  for (let i = 0; i < 400; i++) counts[pool.pickAccount().id] += 1;
  assert.ok(counts.acc_1 > counts.acc_2, `快的应多接活：${JSON.stringify(counts)}`);
  assert.ok(counts.acc_2 > 0, '慢的也必须有机会（minWeight 兜底）');
});

check('fixed：只用第一个', () => {
  useConfig({ strategy: 'fixed', accounts: [acc(1), acc(2)] });
  for (let i = 0; i < 3; i++) assert.equal(pool.pickAccount().id, 'acc_1');
});

check('不认识的 strategy 回落到 weighted（不会因为写错字就空转）', () => {
  useConfig({ strategy: '瞎写的', accounts: [acc(1)] });
  assert.equal(internals.snapshot().strategy, 'weighted');
  assert.ok(pool.pickAccount());
});

// ══ 七、快照 / 增删改 ═════════════════════════════════════════════════
console.log('\n=== 七、快照与增删改 ===');

check('快照 counts 正确，且 Key 已脱敏', () => {
  const p = writeTmp('i.json', {
    endpoints: [
      { name: 'ok', url: `${NV}/chat/completions`, key: 'file-key' },
      { name: 'nokey', url: `${NV}/chat/completions`, key_env: 'NOPE_MISSING' }
    ]
  });
  useConfig({ strategy: 'round-robin', endpointsFile: p, accounts: [acc(1)] });
  const s = internals.snapshot();
  assert.deepEqual(s.counts, { total: 3, eligible: 2, fromConfig: 1, fromFile: 2 });
  assert.ok(s.accounts.every((a) => a.key === '******' || a.key === ''), '快照不得回明文 Key');
});

check('updateAccount 拿不到"文件账号"（只读）', () => {
  const p = writeTmp('j.json', { endpoints: [{ name: 'f', url: `${NV}/chat/completions`, key: 'k' }] });
  useConfig({ strategy: 'round-robin', endpointsFile: p, accounts: [acc(1)] });
  const r = pool.updateAccount('file:f', { name: '改名' });
  assert.ok(r.error, '外部文件里的账号应拒绝修改，并提示去改文件');
});

check('addAccount / removeAccount 只动配置里的账号', () => {
  useConfig({ strategy: 'round-robin', accounts: [] });
  const added = pool.addAccount({ baseUrl: NV, key: 'k', name: '新' });
  assert.equal(added.accounts.length, 1);
  assert.equal(added.account.hasKey, true);
  assert.equal(added.account.key, '******');
  const removed = pool.removeAccount(added.account.id);
  assert.equal(removed.accounts.length, 0);
});

check('空 baseUrl 不允许加（加了也只是个永远挑不中的死账号）', () => {
  useConfig({ strategy: 'round-robin', accounts: [] });
  assert.ok(pool.addAccount({ key: 'k' }).error);
});

fs.rmSync(tmpDir, { recursive: true, force: true });

console.log(`\n通过 ${pass} 项，失败 ${failures.length} 项`);
if (failures.length) {
  console.log('\n失败明细：');
  for (const f of failures) console.log(' -', f);
  process.exit(1);
}
