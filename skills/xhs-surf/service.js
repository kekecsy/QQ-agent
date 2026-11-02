import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { DATA_DIR } from '../../src/config.js';

export const ROOT = path.join(DATA_DIR, 'xhs-surf');
const BASE = 'http://127.0.0.1:18060';
let child;
let starting;
function token() {
  fs.mkdirSync(ROOT, { recursive: true, mode: 0o700 });
  const file = path.join(ROOT, 'service-token');
  try { return fs.readFileSync(file, 'utf8').trim(); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const value = randomBytes(32).toString('hex');
    fs.writeFileSync(file, value, { mode: 0o600, flag: 'wx' });
    return value;
  }
}
export async function request(route, body, timeoutMs = 90000) {
  const allowed = ['/api/v1/login/status', '/api/v1/login/qrcode', '/api/v1/feeds/search', '/api/v1/feeds/detail', '/api/v1/feeds/list'];
  if (!allowed.includes(route)) throw new Error('小红书仅允许登录和只读搜索');
  const response = await fetch(BASE + route, { method: body ? 'POST' : 'GET', redirect: 'error',
    headers: { Authorization: `Bearer ${token()}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(timeoutMs) });
  const reader = response.body.getReader();
  const chunks = []; let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      size += value.length; if (size > 4 * 1024 * 1024) throw new Error('小红书响应过大');
      chunks.push(Buffer.from(value));
    }
  } finally { await reader.cancel(); }
  let json;
  try { json = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new Error(`小红书服务 HTTP ${response.status}，响应不是有效JSON`); }
  if (!response.ok || !json.success) {
    const detail = String(json.details || json.error || '').replace(/https?:\/\/\S+/g, '[地址]').slice(0, 120);
    const stage = route.endsWith('/search') ? '搜索' : route.endsWith('/detail') ? '笔记读取' : route.endsWith('/status') ? '登录检查' : '请求';
    throw new Error(`小红书${stage}失败 HTTP ${response.status}${/deadline|timeout/i.test(detail) ? '：页面加载超时，检查网络或网站验证状态' : ''}`);
  }
  return json.data;
}
export async function ensureService() {
  const healthy = async () => (await fetch(BASE + '/health', { signal: AbortSignal.timeout(2000), redirect: 'error' })).ok;
  try { if (await healthy()) return; } catch { /* start only the managed local service */ }
  if (starting) return starting;
  starting = (async () => {
    token();
    const binary = path.resolve(import.meta.dirname, '../../../tools/xiaohongshu-mcp/xiaohongshu-mcp-darwin-arm64');
    if (!fs.existsSync(binary)) throw new Error('请安装Mac arm64小红书服务到项目旁 tools/xiaohongshu-mcp');
    const log = fs.openSync(path.join(ROOT, 'service.log'), 'a', 0o600);
    try {
      child = spawn(binary, ['-port', '127.0.0.1:18060'], { cwd: ROOT, env: { ...process.env, AUTH_TOKEN: token() }, detached: true, stdio: ['ignore', log, log] });
      child.on('error', () => {});
      child.unref();
    } finally { fs.closeSync(log); }
    for (let i = 0; i < 30; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      try { if (await healthy()) return; } catch { /* browser startup */ }
      if (child.exitCode != null) throw new Error('小红书服务退出，请查看本地service.log');
    }
    throw new Error('小红书服务尚未就绪，请稍后重试');
  })().finally(() => { starting = null; });
  return starting;
}
export function stopService() { child?.kill(); child = null; }
export async function loginQr() {
  await ensureService();
  const result = await request('/api/v1/login/qrcode');
  if (result.is_logged_in) return { loggedIn: true };
  const image = String(result.img || '');
  const match = image.match(/^data:image\/(png|jpeg);base64,([A-Za-z0-9+/=]+)$/);
  if (!match || image.length > 2 * 1024 * 1024) throw new Error('服务未返回有效二维码');
  const file = path.join(ROOT, `login-qr.${match[1] === 'jpeg' ? 'jpg' : 'png'}`);
  fs.writeFileSync(file, Buffer.from(match[2], 'base64'), { mode: 0o600 });
  return { loggedIn: false, qrPath: file };
}
