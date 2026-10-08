import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { DATA_DIR } from '../../src/config.js';

const exec = promisify(execFile);
const dir = path.join(DATA_DIR, 'ygo-ruling');
const luaRepos = [
  { url: 'https://github.com/ProjectIgnis/CardScripts/archive/refs/heads/master.zip', maps: [['CardScripts-master/official', 'official'], ['CardScripts-master/pre-release', 'pre-release']] },
  { url: 'https://github.com/Fluorohydride/ygopro-scripts/archive/refs/heads/master.zip', maps: [['ygopro-scripts-master', 'ygopro']] }
];
const job = { running: false, phase: '', error: '', kind: null };
const read = (file) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };
export function syncStatus() {
  return { ...job, cards: read(path.join(dir, 'cards-manifest.json')), lua: read(path.join(dir, 'scripts-mirror/manifest.json')) };
}
async function download(url, prefixes = ['']) {
  let error;
  for (const prefix of prefixes) {
    try {
      const res = await fetch(prefix + url, { signal: AbortSignal.timeout(90000), headers: { 'user-agent': 'QQ-agent-ygo-ruling' } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length > 150 * 1024 * 1024) throw new Error('下载文件超过大小限制');
      return buf;
    } catch (e) { error = e; }
  }
  throw error;
}
async function extract(zip, target) {
  const tar = process.platform === 'win32' ? path.join(process.env.SystemRoot || 'C:/Windows', 'System32/tar.exe') : '/usr/bin/tar';
  const { stdout } = await exec(tar, ['-tf', zip], { maxBuffer: 16 * 1024 * 1024 });
  if (stdout.split(/\r?\n/).some((s) => s.startsWith('/') || s.includes('\\') || s.split('/').includes('..'))) throw new Error('压缩包包含不安全路径');
  fs.mkdirSync(target, { recursive: true });
  await exec(tar, ['-xf', zip, '-C', target], { timeout: 120000, maxBuffer: 1024 * 1024 });
}
export function validateCards(raw) {
  const cards = JSON.parse(raw);
  if (!cards || typeof cards !== 'object' || Array.isArray(cards)) throw new Error('卡库格式不正确');
  const entries = Object.values(cards).filter((c) => c && c.id && c.text && (c.cn_name || c.jp_name || c.en_name));
  if (!entries.length) throw new Error('卡库没有有效记录');
  return entries.length;
}
function atomicJson(file, value) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value));
  fs.renameSync(tmp, file);
}
async function syncCards(tmp) {
  job.phase = '检查卡库更新';
  const checksum = (await download('https://ygocdb.com/api/v0/cards.zip.md5')).toString().trim();
  const md5 = String(checksum.startsWith('"') ? JSON.parse(checksum) : checksum.split(/\s+/)[0]).toLowerCase();
  if (!/^[a-f0-9]{32}$/.test(md5)) throw new Error('卡库校验值格式不正确');
  const file = path.join(dir, 'cards.json');
  if (fs.existsSync(file) && createHash('md5').update(fs.readFileSync(file)).digest('hex') === md5) {
    job.phase = '卡库已是最新';
    return;
  }
  job.phase = '下载卡库';
  const zip = path.join(tmp, 'cards.zip');
  fs.writeFileSync(zip, await download('https://ygocdb.com/api/v0/cards.zip'));
  await extract(zip, path.join(tmp, 'cards'));
  const raw = fs.readFileSync(path.join(tmp, 'cards/cards.json'));
  if (createHash('md5').update(raw).digest('hex') !== md5) throw new Error('卡库 MD5 校验失败，保留旧卡库');
  const count = validateCards(raw);
  fs.writeFileSync(`${file}.tmp`, raw);
  fs.renameSync(`${file}.tmp`, file);
  atomicJson(path.join(dir, 'cards-manifest.json'), { syncedAt: new Date().toISOString(), count, md5 });
}
async function syncLua(tmp, settings) {
  const prefixes = [...new Set([...String(settings.scriptProxy || '').split(/[,，\s]+/).filter(Boolean).map((s) => s === 'direct' ? '' : s), ''])];
  const stage = path.join(tmp, 'mirror');
  fs.mkdirSync(stage);
  const sources = {};
  for (let i = 0; i < luaRepos.length; i++) {
    const repo = luaRepos[i];
    job.phase = `下载 Lua 脚本源 ${i + 1}/${luaRepos.length}`;
    const zip = path.join(tmp, `lua-${i}.zip`);
    fs.writeFileSync(zip, await download(repo.url, prefixes));
    const extracted = path.join(tmp, `lua-${i}`);
    job.phase = `解压 Lua 脚本源 ${i + 1}/${luaRepos.length}`;
    await extract(zip, extracted);
    for (const [inner, key] of repo.maps) {
      const source = path.join(extracted, inner);
      const files = fs.readdirSync(source).filter((n) => /^c\d{1,12}\.lua$/.test(n));
      if (!files.length) throw new Error(`${key} 未发现 Lua 脚本，保留旧镜像`);
      fs.mkdirSync(path.join(stage, key));
      for (const file of files) {
        if (!fs.lstatSync(path.join(source, file)).isFile()) throw new Error('脚本不是普通文件');
        fs.copyFileSync(path.join(source, file), path.join(stage, key, file));
      }
      sources[key] = files.length;
    }
  }
  atomicJson(path.join(stage, 'manifest.json'), { syncedAt: new Date().toISOString(), sources, totalScripts: Object.values(sources).reduce((a, b) => a + b, 0) });
  const target = path.join(dir, 'scripts-mirror');
  const backup = path.join(tmp, 'old-mirror');
  if (fs.existsSync(target)) fs.renameSync(target, backup);
  try { fs.renameSync(stage, target); } catch (e) { if (fs.existsSync(backup)) fs.renameSync(backup, target); throw e; }
}
export function startSync(kind, settings = {}) {
  if (!['cards', 'lua'].includes(kind)) throw new Error('未知同步类型');
  if (job.running) return syncStatus();
  Object.assign(job, { running: true, error: '', kind, phase: '准备同步' });
  // Run in the background so the settings request does not time out.
  void (async () => {
    let tmp;
    try {
      fs.mkdirSync(dir, { recursive: true });
      tmp = fs.mkdtempSync(path.join(dir, '.sync-'));
      if (kind === 'cards') await syncCards(tmp); else await syncLua(tmp, settings);
      job.phase = '同步完成';
    } catch (e) { job.error = String(e.message || e); job.phase = '同步失败'; }
    finally { if (tmp) fs.rmSync(tmp, { recursive: true, force: true }); job.running = false; }
  })();
  return syncStatus();
}

let cardCache = null;
let cardStamp = '';
export function searchLocalCards(keyword) {
  try {
    const file = path.join(dir, 'cards.json');
    const stat = fs.statSync(file);
    const stamp = `${stat.mtimeMs}:${stat.size}`;
    if (stamp !== cardStamp) { cardCache = Object.values(JSON.parse(fs.readFileSync(file, 'utf8'))).filter((c) => c && c.id && c.text); cardStamp = stamp; }
    const normalize = (s) => String(s || '').replace(/\s+/g, '').toLowerCase();
    const q = normalize(keyword);
    if (!q) return [];
    return cardCache.filter((c) => ['cn_name', 'sc_name', 'md_name', 'nwbbs_n', 'cnocg_n', 'jp_name', 'en_name', 'wiki_en'].some((k) => normalize(c[k]).includes(q)) || String(c.id) === q || String(c.cid) === q).slice(0, 100);
  } catch { return []; }
}
