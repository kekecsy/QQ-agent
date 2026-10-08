// 游戏王查卡快车道 —— 判定逻辑离线测试（**不联网**，用卡库真实返回形状的固定夹具）。
//
// 为什么值得单开一个文件：这个插件的全部风险都集中在"判定"上 —— 抢答错一张卡
// 等于整题答错，而它又是 0 token 直发（没有模型兜底）。判定规则一旦回归，
// 现象是"静默地把某张卡答错"，很难在群里被发现。所以规则改动必须有回归网。
//
// 覆盖：
//   一、extractQuery：去噪 / 触发词 / 判例词必须放行 / 长度闸
//   二、weakMatch：跳字缩写（2026-10-05「阁楼妖」事故）与它的四道防误判约束
//   三、decide：精确 → 直接答；跳字缩写 → **只提问不笃定**；够不上 → 放行
//   四、formatCandidateList：weak 时的措辞必须比普通候选清单更退一步
//
// 跑法：node test/ygo-quick-card-logic.mjs

import assert from 'node:assert/strict';
import {
  extractQuery,
  scoreCard,
  coreKeyword,
  weakMatch,
  isSubsequence,
  truncatedForms,
  looseMatch,
  commonRun,
  normName,
  internals
} from '../plugins/ygo-quick-card/logic.js';

const { DEFAULTS, formatCandidateList, formatCardAnswer } = internals;
const INTENT = DEFAULTS.intentWords.split(',');

let pass = 0;
const failures = [];
function check(name, fn) {
  try {
    fn();
    pass += 1;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failures.push(`${name} → ${error.message}`);
    console.log(`  ✗ ${name} → ${error.message}`);
  }
}

/** 卡库返回形状的夹具（字段与 normalizeCard 对齐）。 */
function card(patch) {
  return {
    id: '12345678', cn_name: '', sc_name: '', md_name: '', nwbbs_n: '', cnocg_n: '',
    jp_name: '', en_name: '', types: '', pdesc: '', desc: '', faqcount: 0,
    ...patch
  };
}

// ── 真实卡：2026-10-05 用户私聊「查卡 阁楼妖」查到的唯一一条 ────────────────
//   简中/民翻/MD 三个名字里都**没有「妖」之外的连续子串关系**，所以「阁楼妖」
//   在旧规则下是 0 分 → 整条被放行给模型（模型花了 1 分 44 秒才问出同一句话）。
const ATTIC = card({
  id: '30208479',
  cn_name: '阁楼上的妖怪',
  sc_name: '阁楼中的怪物',
  md_name: '阁楼里的物之怪',
  nwbbs_n: '阁楼上的妖怪',
  jp_name: '屋根裏の物の怪',
  en_name: 'The Thing in the Attic',
  types: '[怪兽|效果]',
  desc: '①：这张卡可以直接攻击。'
});

console.log('\n=== 一、extractQuery：去噪与放行 ===');

check('「查卡 阁楼妖」→「阁楼妖」（触发词被剥掉）', () => {
  assert.equal(extractQuery('查卡 阁楼妖', { intentWords: INTENT, lenient: true, minLen: 2 }), '阁楼妖');
});
check('裸卡名「阁楼妖」→「阁楼妖」', () => {
  assert.equal(extractQuery('阁楼妖', { intentWords: INTENT, lenient: true, minLen: 2 }), '阁楼妖');
});
check('私聊（lenient）不需要触发词', () => {
  assert.equal(extractQuery('阁楼妖', { intentWords: INTENT, lenient: true, requireIntent: true, minLen: 2 }), '阁楼妖');
});
check('群里没 @ 也没触发词且 requireIntent → 放行（null）', () => {
  assert.equal(extractQuery('阁楼妖', { intentWords: INTENT, lenient: false, requireIntent: true, minLen: 2 }), null);
});
check('判例意图一律放行：「灵魂交换能不能解放月光舞狮子神姬」', () => {
  assert.equal(extractQuery('灵魂交换能不能解放月光舞狮子神姬', { intentWords: INTENT, lenient: true, minLen: 2 }), null);
});
check('判例意图一律放行：「羽毛扫会不会被无效」', () => {
  assert.equal(extractQuery('羽毛扫会不会被无效', { intentWords: INTENT, lenient: true, minLen: 2 }), null);
});
check('单字被长度闸挡掉', () => {
  assert.equal(extractQuery('龙', { intentWords: INTENT, lenient: true, minLen: 2 }), null);
});
check('@ 片段被清掉：「@薄荷 羽毛扫」→「羽毛扫」', () => {
  assert.equal(extractQuery('@薄荷 羽毛扫', { intentWords: INTENT, lenient: true, minLen: 2 }), '羽毛扫');
});

console.log('\n=== 二、weakMatch：跳字缩写与四道约束 ===');

check('isSubsequence 基础语义', () => {
  assert.equal(isSubsequence('阁楼妖', '阁楼上的妖怪'), true);
  assert.equal(isSubsequence('阁楼怪', '阁楼上的妖怪'), true);
  assert.equal(isSubsequence('妖阁楼', '阁楼上的妖怪'), false); // 顺序不能乱
  assert.equal(isSubsequence('阁楼妖', '阁楼中的怪物'), false); // 没有「妖」
});
check('「阁楼妖」跳字命中【阁楼上的妖怪】', () => {
  const hit = weakMatch(ATTIC, '阁楼妖');
  assert.ok(hit, '应当命中');
  assert.ok(hit.ratio >= 0.4, `覆盖率应达标，实际 ${hit.ratio}`);
});
check('约束①：英文查询不启用（按字符比太松）', () => {
  const c = card({ cn_name: '', en_name: 'Ash Blossom & Joyous Spring' });
  assert.equal(weakMatch(c, 'Ash'), null);
});
check('约束②：首字不同不认（【黑魔导女武神】vs「青魔女」）', () => {
  const c = card({ cn_name: '黑魔导女武神' });
  assert.equal(weakMatch(c, '青魔女'), null);
});
check('约束③：别名比查询长太多不认（「龙」不会吸住长名字）', () => {
  const c = card({ cn_name: '真红眼黑龙剑士的究极形态' });
  assert.equal(weakMatch(c, '龙剑'), null);
});
check('约束④：覆盖率不足不认（3 个字套 10 个字的别名）', () => {
  const c = card({ cn_name: '青眼白龙究极龙骑士团长' });
  assert.equal(weakMatch(c, '青眼士'), null);
});
check('单字查询不启用（minLen 之外再保一道）', () => {
  assert.equal(weakMatch(ATTIC, '妖'), null);
});
check('连续子串的情形本来就走正常打分，不依赖 weakMatch', () => {
  assert.equal(scoreCard(ATTIC, '阁楼上的妖怪').score, 100);
  assert.equal(scoreCard(ATTIC, '阁楼上的').score, 60);
  assert.equal(scoreCard(ATTIC, '阁楼妖').score, 0, '旧规则的 0 分正是事故根因');
});
check('coreKeyword 不会为「阁楼妖」产出补搜词（没有虚词可去）', () => {
  assert.equal(coreKeyword('阁楼妖'), '阁楼妖');
});

console.log('\n=== 三、decide：只提问、不笃定 ===');

// decide 只依赖 this.opts()，构造一个**不联网**的实例即可直测
const { QuickCard } = await import('../plugins/ygo-quick-card/logic.js');
const engine = new QuickCard({ settings: () => ({}), fetchImpl: () => { throw new Error('本测试不应联网'); } });

check('精确命中 → kind=card（笃定回答）', () => {
  const d = engine.decide('羽毛扫', { cards: [card({ cn_name: '鹰身女妖的羽毛扫', sc_name: '神鹰羽毛扫' })], effective: '羽毛扫' });
  assert.equal(d.kind, 'card');
  assert.equal(d.exact, false, '60 分命中属于"按这张理解"，不是精确相等');
});

check('跳字缩写且候选只有 1 张 → kind=list + reason=weak（提问，不笃定）', () => {
  const d = engine.decide('阁楼妖', { cards: [ATTIC], effective: '阁楼妖' });
  assert.equal(d.kind, 'list', '必须是提问，不能是确定回答');
  assert.equal(d.reason, 'weak');
  assert.equal(d.items.length, 1);
  assert.equal(d.items[0].card.cn_name, '阁楼上的妖怪');
});

check('跳字缩写但候选有 3 张 → 放行（收敛不了就不猜）', () => {
  const d = engine.decide('阁楼妖', {
    cards: [ATTIC, card({ cn_name: '阁楼上的妖怪二号' }), card({ cn_name: '阁楼上的妖怪三号' })],
    effective: '阁楼妖'
  });
  assert.equal(d, null);
});

check('乱串 + 唯一候选但非跳字关系 → 放行（不会把"没这张卡"答成一张卡）', () => {
  const d = engine.decide('随手打的几个字', { cards: [ATTIC], effective: '随手打的几个字' });
  assert.equal(d, null);
});

check('开关关掉 → 跳字缩写也放行（回到旧行为）', () => {
  const off = new QuickCard({ settings: () => ({ askOnWeakMatch: false }), fetchImpl: () => {} });
  assert.equal(off.decide('阁楼妖', { cards: [ATTIC], effective: '阁楼妖' }), null);
});

console.log('\n=== 四、weak 时措辞必须更退一步 ===');

check('普通候选清单说「对得上 N 张」', () => {
  const text = formatCandidateList({ items: [{ card: ATTIC }], query: '阁楼', total: 3 });
  assert.ok(text.includes('对得上 3 张'), text);
});
check('weak 清单说「没找到同名卡，最接近的是下面这张」', () => {
  const text = formatCandidateList({ items: [{ card: ATTIC }], query: '阁楼妖', total: 1, reason: 'weak' });
  assert.ok(text.includes('没找到同名的卡'), text);
  assert.ok(text.includes('你说的是它吗'), text);
  assert.ok(!text.includes('对得上'), 'weak 时不能出现"对得上"');
});
check('truncated 清单请用户指认，并写明按什么词搜的', () => {
  const text = formatCandidateList({ items: [{ card: ATTIC }], query: '阁楼妖', total: 2, reason: 'truncated', searchedAs: '阁楼' });
  assert.ok(text.includes('没查到同名的卡'), text);
  assert.ok(text.includes('按「阁楼」找到这几张'), text);
  assert.ok(text.includes('你要的是哪一张'), text);
  assert.ok(!text.includes('对得上'), 'truncated 时同样不能出现"对得上"');
});
check('清单里绝不出现密码 / cid', () => {
  const text = formatCandidateList({ items: [{ card: ATTIC }], query: '阁楼妖', total: 1, reason: 'weak' });
  assert.ok(!text.includes('30208479'), '卡名列里不得带密码');
});

console.log('\n=== 五、截断补搜：用户把最后一个字说岔了（2026-10-05「阁楼妖」事故）===');

// 卡库真实行为的替身：按关键词返回固定夹具（实测数据，见 logic.js 里 truncatedForms 注释）
const MEM = card({
  id: '52918032',
  cn_name: '莫忘阁楼怪',
  sc_name: '冥铭途・楼中怪',
  md_name: '冥铭途・楼中怪',
  nwbbs_n: '莫忘阁楼怪',
  cnocg_n: '无忘阁楼魂灵',
  jp_name: 'メメント・アティックゴースト',
  en_name: 'Memento Attic Ghost',
  types: '[怪兽|效果]',
  desc: '①：这张卡被战斗破坏的场合才能发动。'
});
const DB = {
  '阁楼妖': [ATTIC],            // 实测：只回这一条，**没有**莫忘阁楼怪
  '阁楼': [ATTIC, MEM],         // 实测：两条都给
  '莫忘阁楼怪': [MEM],
  '莫忘阁楼妖': [MEM],          // 实测 2026-10-06：用户末字说岔（怪→妖），只回这一条且 0 分
  '莫忘阁楼': [MEM],
  '冥铭途阁楼妖': [],           // 实测 2026-10-06：0 条（拼名拼得太乱）
  '冥铭途阁楼': [MEM]           // 实测：卡库自己做多片段模糊匹配，只回这一条 —— 而别名不含这个连续串
};
const stubFetch = (url) => {
  const kw = decodeURIComponent(String(url).replace(/^.*search=/, ''));
  return Promise.resolve({
    ok: true,
    json: () => Promise.resolve({ result: (DB[kw] || []).map((c) => ({
      id: c.id, cn_name: c.cn_name, sc_name: c.sc_name, md_name: c.md_name,
      nwbbs_n: c.nwbbs_n, cnocg_n: c.cnocg_n, jp_name: c.jp_name, en_name: c.en_name,
      text: { name: c.cn_name, types: c.types, desc: c.desc, pdesc: c.pdesc }
    })) })
  });
};
const netEngine = new QuickCard({ settings: () => ({}), fetchImpl: stubFetch });

check('truncatedForms：「阁楼妖」→ 只截出 2 字以上的词', () => {
  assert.deepEqual(truncatedForms('阁楼妖'), ['阁楼']);
  assert.deepEqual(truncatedForms('青眼白龙'), ['青眼白', '青眼']);
  assert.deepEqual(truncatedForms('龙'), [], '单字没有可截的');
});

check('allowTruncate=false（群里路过）：卡库给什么就是什么，不补搜', async () => {
  const r = await netEngine.resolve('阁楼妖', { allowTruncate: false });
  assert.equal(r.cards.length, 1);
  assert.equal(r.truncatedFrom, '');
});

check('allowTruncate=true（私聊/@）：按「阁楼」补搜，把莫忘阁楼怪捞回来', async () => {
  const r = await netEngine.resolve('阁楼妖', { allowTruncate: true });
  assert.equal(r.truncatedFrom, '阁楼');
  const names = r.cards.map((c) => c.cn_name).sort();
  assert.deepEqual(names, ['阁楼上的妖怪', '莫忘阁楼怪'].sort());
});

check('补搜后 decide → 清单提问，用户真正想找的那张在列表里', async () => {
  const r = await netEngine.resolve('阁楼妖', { allowTruncate: true });
  const d = netEngine.decide('阁楼妖', r);
  assert.equal(d.kind, 'list');
  assert.equal(d.reason, 'truncated');
  const names = d.items.map((x) => x.card.cn_name);
  assert.ok(names.includes('莫忘阁楼怪'), `列表里必须有莫忘阁楼怪，实际 ${names.join('/')}`);
  assert.ok(names.includes('阁楼上的妖怪'), `列表里也应有阁楼上的妖怪，实际 ${names.join('/')}`);
});

check('截断补搜不会把候选当成"确定的卡"答出去', async () => {
  const r = await netEngine.resolve('阁楼妖', { allowTruncate: true });
  const d = netEngine.decide('阁楼妖', r);
  assert.notEqual(d.kind, 'card', '这一路永远只能提问');
  assert.ok(!('card' in d));
});

check('缓存键区分两种模式：先跑群里路过，再跑私聊也要能补搜', async () => {
  const e = new QuickCard({ settings: () => ({}), fetchImpl: stubFetch });
  const a = await e.resolve('阁楼妖', { allowTruncate: false });
  const b = await e.resolve('阁楼妖', { allowTruncate: true });
  assert.equal(a.cards.length, 1);
  assert.equal(b.cards.length, 2, '两种模式的缓存不能互相污染');
});

check('能直接命中的词不走截断（「阁楼怪」→ 莫忘阁楼怪，60 分直接答）', async () => {
  const e = new QuickCard({ settings: () => ({}) , fetchImpl: (url) => {
    const kw = decodeURIComponent(String(url).replace(/^.*search=/, ''));
    const hit = kw === '阁楼怪' ? [MEM] : (DB[kw] || []);
    return Promise.resolve({ ok: true, json: () => Promise.resolve({ result: hit.map((c) => ({
      id: c.id, cn_name: c.cn_name, sc_name: c.sc_name, md_name: c.md_name, nwbbs_n: c.nwbbs_n,
      cnocg_n: c.cnocg_n, jp_name: c.jp_name, en_name: c.en_name,
      text: { name: c.cn_name, types: c.types, desc: c.desc, pdesc: c.pdesc } })) }) });
  } });
  const r = await e.resolve('阁楼怪', { allowTruncate: true });
  const d = e.decide('阁楼怪', r);
  assert.equal(d.kind, 'card');
  assert.equal(d.card.cn_name, '莫忘阁楼怪');
});

console.log('\n=== 六、截断补搜只剩一张且词够长 → 直接给卡面（2026-10-06 两次事故）===');
// 事故 A：用户末字说岔（怪→妖）「查卡 莫忘阁楼妖」→ 卡库对原词只回 1 条且 0 分
//         → 按「莫忘阁楼」补搜仍只 1 条 → 旧行为回「你要的是哪一张？」清单，**连效果都没给**。
// 事故 B：用户把简中名前缀和中文名中段拼起来「查卡 冥铭途阁楼妖」→ 卡库对原词回 0 条，
//         但对「冥铭途阁楼」只回【莫忘阁楼怪】1 条（卡库自己做多片段模糊匹配），
//         而这张卡任何别名都不含「冥铭途阁楼」这个连续串 → 0 分被门槛筛掉 → 整条放行给模型。

check('commonRun / looseMatch：四道闸缺一不可', () => {
  assert.equal(commonRun('冥铭途阁楼', '莫忘阁楼怪'), 2, '连续公共段是「阁楼」');
  assert.equal(commonRun('明天', '骸骨天使'), 1, '只共用一个「天」');
  assert.equal(looseMatch(MEM, '冥铭途阁楼'), true, '每字都在卡名里 + 有 ≥2 字连续段 → 认');
  assert.equal(looseMatch(MEM, '这把输'), false, '② 有字不在卡名里 → 不认');
  assert.equal(looseMatch({ cn_name: '甲乙丙' }, '甲丙乙'), false, '③ 最长的连续公共段只有 1 字 → 不认');
  assert.equal(looseMatch({ cn_name: '骸骨明天使' }, '明天'), false, '④ 两字搜索词一律不认（常用词撞名）');
  assert.equal(looseMatch(MEM, '52918032'), false, '密码不参与"像卡名"判断');
});

check('「莫忘阁楼妖」→ resolve 走「莫忘阁楼」补搜', async () => {
  const r = await netEngine.resolve('莫忘阁楼妖', { allowTruncate: true });
  assert.equal(r.truncatedFrom, '莫忘阁楼');
  assert.equal(r.cards.length, 1);
  assert.equal(r.cards[0].cn_name, '莫忘阁楼怪');
});

check('只剩一张且搜索词 ≥3 字 → kind=card（不再问"哪一张"）', async () => {
  const r = await netEngine.resolve('莫忘阁楼妖', { allowTruncate: true });
  const d = netEngine.decide('莫忘阁楼妖', r);
  assert.equal(d.kind, 'card', '这种情况意图没有歧义，必须直接答');
  assert.equal(d.card.cn_name, '莫忘阁楼怪');
  assert.equal(d.inferred, '莫忘阁楼', '要记住是按哪个词找到的，末尾要点明');
});

check('卡面必须带效果文本（事故的直接诉求），并点明按哪个词找到的', async () => {
  const r = await netEngine.resolve('莫忘阁楼妖', { allowTruncate: true });
  const text = formatCardAnswer(netEngine.decide('莫忘阁楼妖', r));
  assert.ok(text.includes('莫忘阁楼怪'), text);
  assert.ok(text.includes('被战斗破坏的场合才能发动'), '必须给效果，这正是用户抱怨缺的东西');
  assert.ok(text.includes('按「莫忘阁楼」找的'), text);
  assert.ok(!text.includes('52918032'), '卡面里不得带密码');
});

check('「冥铭途阁楼妖」→ 卡库多片段模糊命中，按唯一候选直接答', async () => {
  const r = await netEngine.resolve('冥铭途阁楼妖', { allowTruncate: true });
  assert.equal(r.cards.length, 1);
  const d = netEngine.decide('冥铭途阁楼妖', r);
  assert.equal(d.kind, 'card', '卡库只回这一张，不该整条放行给模型');
  assert.equal(d.card.cn_name, '莫忘阁楼怪');
  assert.equal(d.loose, true);
  const text = formatCardAnswer(d);
  assert.ok(text.includes('被战斗破坏的场合才能发动'), text);
  assert.ok(text.includes('按「冥铭途阁楼」找的'), text);
});

check('真歧义（补搜出 2 张）仍只提问、不给效果 —— 不能退化成猜', async () => {
  const r = await netEngine.resolve('阁楼妖', { allowTruncate: true });
  const d = netEngine.decide('阁楼妖', r);
  assert.equal(d.kind, 'list');
  assert.equal(d.reason, 'truncated');
});

check('唯一候选但搜索词只有 2 字 → 仍提问（常用词撞名的巧合太多）', async () => {
  // 卡库对「阁楼妖」回空、对「阁楼」只回【阁楼上的妖怪】：搜索词 2 字，不给卡面
  const only = new QuickCard({ settings: () => ({}), fetchImpl: (url) => {
    const kw = decodeURIComponent(String(url).replace(/^.*search=/, ''));
    const hit = kw === '阁楼' ? [ATTIC] : [];
    return Promise.resolve({ ok: true, json: () => Promise.resolve({ result: hit.map((c) => ({
      id: c.id, cn_name: c.cn_name, sc_name: c.sc_name, md_name: c.md_name, nwbbs_n: c.nwbbs_n,
      cnocg_n: c.cnocg_n, jp_name: c.jp_name, en_name: c.en_name,
      text: { name: c.cn_name, types: c.types, desc: c.desc, pdesc: c.pdesc } })) }) });
  } });
  const r = await only.resolve('阁楼妖', { allowTruncate: true });
  const d = only.decide('阁楼妖', r);
  assert.equal(d.kind, 'list', '两字搜索词不给卡面，仍走提问清单');
});

check('闲聊句子不会因为"卡库只回一张"被答成卡（误报回归）', async () => {
  // 实测：'明天有空吗' 截到「明天」时卡库只回【骸骨天使】；'这把输了' 截到「这把输」
  // 只回【同盟运输车】；'灰流丽真的烦' 截到「灰流丽真的」只回【灰流丽】
  const chat = new QuickCard({ settings: () => ({}), fetchImpl: (url) => {
    const kw = decodeURIComponent(String(url).replace(/^.*search=/, ''));
    const DB2 = {
      '明天有': [card({ cn_name: '骸骨天使' }), card({ cn_name: '黎明之堕天使 路西菲尔' })],
      '明天': [card({ cn_name: '骸骨明天使' })],
      '把输': [card({ cn_name: '同盟运输车' })],
      '灰流丽真的': [card({ cn_name: '灰流丽' })]
    };
    return Promise.resolve({ ok: true, json: () => Promise.resolve({ result: (DB2[kw] || []).map((c) => ({
      id: c.id, cn_name: c.cn_name, sc_name: c.sc_name, md_name: c.md_name, nwbbs_n: c.nwbbs_n,
      cnocg_n: c.cnocg_n, jp_name: c.jp_name, en_name: c.en_name,
      text: { name: c.cn_name, types: c.types, desc: c.desc, pdesc: c.pdesc } })) }) });
  } });
  const a = chat.decide('明天有空', await chat.resolve('明天有空', { allowTruncate: true }));
  assert.notEqual(a?.kind, 'card', '「明天有空」不能被答成一张卡');
  const b = chat.decide('灰流丽真的烦', await chat.resolve('灰流丽真的烦', { allowTruncate: true }));
  assert.equal(b, null, '「灰流丽真的烦」不是查卡，应放行（"真的"不在卡名里）');
});

check('开关关掉 → 回到旧的提问式清单', async () => {
  const off = new QuickCard({ settings: () => ({ answerOnSingleTruncate: false }), fetchImpl: stubFetch });
  const r = await off.resolve('莫忘阁楼妖', { allowTruncate: true });
  const d = off.decide('莫忘阁楼妖', r);
  assert.equal(d.kind, 'list');
  assert.equal(d.reason, 'truncated');
});

console.log(`\n通过 ${pass} 项，失败 ${failures.length} 项`);
if (failures.length) {
  console.log('\n失败明细：');
  for (const f of failures) console.log('  ✗', f);
  process.exit(1);
}
console.log('全部通过');
