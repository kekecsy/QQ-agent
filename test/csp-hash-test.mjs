/**
 * CSP 哈希一致性测试：首屏主题预置脚本的「实际内容」必须与「两份 CSP」三处对齐。
 *
 * 背景（2026-10-06 真实踩过）：
 *   ui/index.html 有一处**内联** <script>（在样式生效前定好 data-theme，避免首屏
 *   闪白）。项目刻意不用 'unsafe-inline'，改用该脚本的 sha256 精确放行；而 CSP 写了
 *   **两份** —— index.html 的 meta 版 + src/app.js 的 HTTP 头版，浏览器取交集执行。
 *
 *   于是任何一处漂移都会**静默失效**：内联脚本被浏览器拦下，界面看起来还能跑，
 *   只是首屏闪白 / 主题不对，控制台也不会直白地报错。本次的实况是：
 *   脚本实际哈希是 Aus…，而两份 CSP 里写的都还是旧值 HJ5…。
 *
 * 本测试把这条"看不见的契约"钉死：三处不一致就红。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const raw = fs.readFileSync(path.join(root, 'ui', 'index.html'));   // 拿 Buffer：CRLF 也要参与哈希
const html = raw.toString('utf8');
const app = fs.readFileSync(path.join(root, 'src', 'app.js'), 'utf8');

let bad = 0;
const check = (label, fn) => {
  try { fn(); console.log(`  [ok] ${label}`); }
  catch (e) { bad++; console.log(`  [FAIL] ${label} -- ${e.message}`); }
};

// 浏览器算 CSP hash 的方式：对该 <script> 元素的**文本内容**按 UTF-8 字节做 sha256。
const inlineHashes = [];
const re = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g;
let m;
while ((m = re.exec(html))) {
  const digest = crypto.createHash('sha256').update(Buffer.from(m[1], 'utf8')).digest('base64');
  inlineHashes.push(`sha256-${digest}`);   // base64 自带 '=' 填充，不要再补
}

console.log('\n== CSP 哈希一致性 ==');

check('index.html 恰好 1 处内联脚本（数量变了就得同步本测试与两份 CSP）', () => {
  assert.equal(inlineHashes.length, 1, `实际 ${inlineHashes.length} 处`);
});

const hash = inlineHashes[0] || '';
const metaCsp = (html.match(/<meta http-equiv="Content-Security-Policy" content="([^"]*)"/) || [])[1] || '';
const headerLine = (app.match(/"[^"\n]*script-src[^"\n]*"/) || [])[0] || '';
const hashesIn = (s) => [...new Set([...s.matchAll(/sha256-[A-Za-z0-9+/]+=*/g)].map((x) => x[0]))];

check('meta CSP 的 script-src 只放行这一个哈希（且就是它）', () => {
  assert.deepEqual(hashesIn((metaCsp.match(/script-src[^;]*/) || [''])[0]), [hash]);
});

check('HTTP 头（src/app.js）的 script-src 只放行这一个哈希（且就是它）', () => {
  assert.deepEqual(hashesIn(headerLine), [hash]);
});

check('两处都显式声明了本脚本的哈希', () => {
  assert.ok(hash, '没能从 index.html 抽出内联脚本哈希');
  assert.ok(metaCsp.includes(hash), `meta 缺 ${hash}`);
  assert.ok(headerLine.includes(hash), `HTTP 头缺 ${hash}`);
});

console.log(bad ? `\n${bad} 项失败\n` : '\n全部通过\n');
process.exit(bad ? 1 : 0);
