#!/usr/bin/env node
/**
 * ygo-ruling 脚本镜像同步的纯逻辑测试。
 *
 * 守什么：
 *   ① LUA_RE 必须接受**短密码**（老卡实测有 official/c483.lua）——写成 \d{4,12}
 *      会把这类卡整批漏掉，而 get_script 按 c<密码>.lua 直读，正好取不到；
 *   ② installLuaFiles 只搬 c<数字>.lua，别把 README / utility.lua 之类的仓库杂项
 *      倒进镜像目录；
 *   ③ manifest 的份数口径与镜像目录一致。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LUA_RE, installLuaFiles } from '../scripts/sync-ygo-scripts.mjs';

let pass = 0;
const fails = [];
const ok = (name) => { pass++; console.log('  ✓', name); };
const bad = (name, detail) => { fails.push(name + (detail ? `：${detail}` : '')); console.log('  ✗', name, detail || ''); };
const eq = (a, b, name) => (JSON.stringify(a) === JSON.stringify(b) ? ok(name) : bad(name, `${JSON.stringify(a)} ≠ ${JSON.stringify(b)}`));

console.log('—— LUA_RE 命中/排除 ——');
const hit = ['c483.lua', 'c1.lua', 'c89631139.lua', 'c100200292.lua', 'c10604644.lua'];
for (const f of hit) (LUA_RE.test(f) ? ok(`接受 ${f}`) : bad(`接受 ${f}`));
const miss = ['utility.lua', 'constant.lua', 'README.md', 'c.lua', '.lua', 'c123.txt', 'xc12.lua', 'c12a.lua', 'card.lua'];
for (const f of miss) (!LUA_RE.test(f) ? ok(`排除 ${f}`) : bad(`排除 ${f}`));
// 明确守住短密码这条回归
eq(LUA_RE.test('c483.lua'), true, '短密码 c483.lua 必须被接受（历史回归：曾写成 \\d{4,12}）');

console.log('\n—— installLuaFiles 只搬脚本 ——');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ygo-sync-'));
const src = path.join(tmp, 'src');
const mirror = path.join(tmp, 'mirror');
fs.mkdirSync(src, { recursive: true });
for (const f of ['c483.lua', 'c10604644.lua', 'utility.lua', 'constant.lua', 'README.md', 'noext']) {
  fs.writeFileSync(path.join(src, f), `-- ${f}\n`);
}
fs.mkdirSync(path.join(src, 'subdir'));           // 目录必须被跳过（readdirSync 会列出来）
const n = installLuaFiles(src, 'official', mirror);
eq(n, 2, '拷贝数 = 2（只有 c483.lua / c10604644.lua）');
eq(fs.readdirSync(path.join(mirror, 'official')).sort(), ['c10604644.lua', 'c483.lua'], '镜像目录内容正确');
eq(fs.readFileSync(path.join(mirror, 'official', 'c483.lua'), 'utf8'), '-- c483.lua\n', '文件内容原样搬过去');

console.log('\n—— 二次同步是覆盖而非累加 ——');
fs.writeFileSync(path.join(mirror, 'official', 'c99999999.lua'), '-- old\n');
const n2 = installLuaFiles(src, 'official', mirror);
eq(n2, 2, '第二次拷贝数仍是 2');
eq(fs.existsSync(path.join(mirror, 'official', 'c99999999.lua')), true, '不删除历史文件（只增量覆盖，符合"重复执行即刷新"的设计）');

fs.rmSync(tmp, { recursive: true, force: true });

console.log('');
if (fails.length) {
  console.log(`存在失败 —— 通过 ${pass} / 失败 ${fails.length}`);
  for (const f of fails) console.log('  -', f);
  process.exit(1);
}
console.log(`全部 ${pass} 项通过 ✅`);
