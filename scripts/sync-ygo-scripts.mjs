#!/usr/bin/env node
/**
 * 全量同步 YGO Lua 脚本到本地镜像 —— 跑一次，判例查询零网络。
 *
 *   node scripts/sync-ygo-scripts.mjs [--proxy https://gh-proxy.com/] [--out <目录>]
 *
 * 下载两个 GitHub 仓库的 zip 包（走 gh-proxy 代理，直连兜底），解压出所有
 * c<密码>.lua，按优先级落盘到 data/ygo-ruling/scripts-mirror/：
 *
 *   official/    ← ProjectIgnis/CardScripts 的 official/
 *   pre-release/ ← ProjectIgnis/CardScripts 的 pre-release/
 *   ygopro/      ← Fluorohydride/ygopro-scripts 根目录（先行卡收录快）
 *
 * skills/ygo-ruling 的 get_script 会按 official → pre-release → ygopro 的顺序
 * 优先读镜像（无 TTL），镜像没有的卡才回退到在线抓取。重复执行即全量刷新。
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SKILL_DATA_DIR = path.join(ROOT, 'data', 'ygo-ruling');
const MIRROR_DIR = path.join(SKILL_DATA_DIR, 'scripts-mirror');
const TMP_DIR = path.join(SKILL_DATA_DIR, '.sync-tmp');
// ⚠️ 下限只能到 1 位：老卡密码很短（实测 official/c483.lua 是「パラレル・テレポート」），
// 写成 \d{4,12} 会把这类卡整批漏掉，而 get_script 按 c<密码>.lua 直读，正好取不到。
export const LUA_RE = /^c(\d{1,12})\.lua$/;

// 与 skill.json settings.scriptProxy 同源的代理前缀；末尾总留一个直连兜底
const PROXIES = [
  'https://gh-proxy.com/',
  'https://ghproxy.net/',
  ''
];

const REPOS = [
  {
    name: 'ProjectIgnis/CardScripts',
    zip: 'https://github.com/ProjectIgnis/CardScripts/archive/refs/heads/master.zip',
    // zip 解压后的顶层目录 → 镜像 key
    maps: [
      { inner: 'CardScripts-master/official', key: 'official' },
      { inner: 'CardScripts-master/pre-release', key: 'pre-release' }
    ]
  },
  {
    name: 'Fluorohydride/ygopro-scripts',
    zip: 'https://github.com/Fluorohydride/ygopro-scripts/archive/refs/heads/master.zip',
    maps: [
      { inner: 'ygopro-scripts-master', key: 'ygopro' }
    ]
  }
];

// 抽查这几个 id，证明镜像真的落盘了（炎舞-天玑 / 轩辕十四 / 西艾萝-一掷乾坤）
const SPOT_CHECK = ['57103969', '10604644', '73090586'];

// ────────────────────────────

const argProxy = (() => {
  const i = process.argv.indexOf('--proxy');
  return i >= 0 ? process.argv[i + 1] : null;
})();
const proxies = argProxy ? [argProxy, ''] : PROXIES;

const log = (...a) => console.log('[sync]', ...a);

async function download(url, dest) {
  for (const prefix of proxies) {
    const u = prefix + url;
    try {
      log('下载', prefix ? `经 ${prefix.replace(/\/$/, '')}` : '直连', '...');
      const res = await fetch(u, {
        signal: AbortSignal.timeout(300000),
        redirect: 'follow',
        headers: { 'user-agent': 'Mozilla/5.0' }
      });
      if (!res.ok) { log(`  ${res.status}，换下一个通道`); continue; }
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length < 1000) { log('  内容过小，疑似失败页，换通道'); continue; }
      fs.writeFileSync(dest, buf);
      log(`  ${(buf.length / 1048576).toFixed(1)} MB → ${path.basename(dest)}`);
      return true;
    } catch (e) {
      log(`  失败（${e?.message ?? e}），换下一个通道`);
    }
  }
  return false;
}

function extract(zipPath, outDir) {
  fs.mkdirSync(outDir, { recursive: true });
  // ⚠️ PATH 里排在前面的 tar 可能是 Git 自带的 GNU tar（不能解 zip）。
  // Windows 优先用系统自带的 bsdtar（System32\tar.exe），失败再逐级降级。
  const candidates = process.platform === 'win32'
    ? ['C:/Windows/System32/tar.exe', 'tar', 'powershell']
    : ['tar'];
  const errors = [];
  for (const cmd of candidates) {
    if (cmd === 'powershell') {
      // 兜底：Windows PowerShell 的 Expand-Archive
      const r = spawnSync('powershell', [
        '-NoProfile', '-Command',
        `Expand-Archive -LiteralPath '${zipPath}' -DestinationPath '${outDir}' -Force`
      ], { stdio: 'pipe' });
      if (r.status === 0) return;
      errors.push(`powershell: ${r.stderr?.toString().slice(0, 200)}`);
      continue;
    }
    const r = spawnSync(cmd, ['-xf', zipPath, '-C', outDir], { stdio: 'pipe' });
    if (r.status === 0) return;
    errors.push(`${cmd}: ${r.error ? r.error.code + ' ' + r.error.message : (r.stderr?.toString().slice(0, 200) || 'exit ' + r.status)}`);
  }
  throw new Error('解压失败（依次试过 ' + candidates.join(' → ') + '）：\n' + errors.join('\n'));
}

/** 把解压目录里的 c<id>.lua 全拷进镜像 key 目录，返回拷贝数（导出供测试用） */
export function installLuaFiles(srcDir, key, mirrorDir = MIRROR_DIR) {
  const destDir = path.join(mirrorDir, key);
  fs.mkdirSync(destDir, { recursive: true });
  let count = 0;
  for (const name of fs.readdirSync(srcDir)) {
    if (!LUA_RE.test(name)) continue;
    fs.copyFileSync(path.join(srcDir, name), path.join(destDir, name));
    count++;
  }
  return count;
}

async function main() {
  const t0 = Date.now();
  fs.mkdirSync(TMP_DIR, { recursive: true });
  const summary = { syncedAt: new Date().toISOString(), sources: {} };

  for (const repo of REPOS) {
    const zipPath = path.join(TMP_DIR, repo.name.split('/')[1] + '.zip');
    const extractDir = path.join(TMP_DIR, 'extract-' + repo.name.split('/')[1]);
    // 上次跑挂了解压时，zip 还在 —— 大于 1MB 就复用，省一次 22MB 下载
    const reuse = fs.existsSync(zipPath) && fs.statSync(zipPath).size > 1024 * 1024;
    if (reuse) {
      log(`=== ${repo.name}（复用已下载的 zip，${(fs.statSync(zipPath).size / 1048576).toFixed(1)} MB）===`);
    } else {
      log(`=== ${repo.name} ===`);
      if (!(await download(repo.zip, zipPath))) {
        log('❌ 全部通道失败，跳过该仓库');
        continue;
      }
    }
    log('解压...');
    fs.rmSync(extractDir, { recursive: true, force: true });
    extract(zipPath, extractDir);
    for (const m of repo.maps) {
      const srcDir = path.join(extractDir, m.inner);
      if (!fs.existsSync(srcDir)) { log(`⚠️ 仓库里没有 ${m.inner}，跳过`); continue; }
      const count = installLuaFiles(srcDir, m.key);
      summary.sources[m.key] = count;
      log(`  ${m.key}: ${count} 个脚本 → scripts-mirror/${m.key}/`);
    }
  }

  // 清理临时
  fs.rmSync(TMP_DIR, { recursive: true, force: true });

  // 抽查
  log('=== 抽查 ===');
  for (const id of SPOT_CHECK) {
    const hits = [];
    for (const key of ['official', 'pre-release', 'ygopro']) {
      if (fs.existsSync(path.join(MIRROR_DIR, key, `c${id}.lua`))) hits.push(key);
    }
    log(`  c${id}.lua → ${hits.length ? hits.join(', ') : '❌ 未命中'}`);
  }

  // 清点 + 写 manifest
  let total = 0;
  for (const key of fs.existsSync(MIRROR_DIR) ? fs.readdirSync(MIRROR_DIR) : []) {
    const dir = path.join(MIRROR_DIR, key);
    if (!fs.statSync(dir).isDirectory()) continue;
    const n = fs.readdirSync(dir).filter((f) => LUA_RE.test(f)).length;
    total += n;
  }
  summary.totalScripts = total;
  fs.writeFileSync(path.join(MIRROR_DIR, 'manifest.json'), JSON.stringify(summary, null, 2));
  log(`=== 完成：镜像共 ${total} 个脚本，耗时 ${((Date.now() - t0) / 1000).toFixed(0)}s ===`);
  if (total === 0) {
    console.error('[sync] ⚠️ 一个脚本都没落盘 —— 检查网络/代理后重跑。');
    process.exit(1);
  }
}

// 直接运行时才执行同步；被 import（测试）时只导出纯函数。
const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) {
  main().catch((e) => { console.error('[sync] 失败：', e); process.exit(1); });
}
