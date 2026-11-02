import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Only the local settings API exposes this controller; it is never an LLM tool.
export function createServiceControl(root, { fetch: http = globalThis.fetch, spawnProcess = spawn,
  platform = process.platform, alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } }, now = Date.now } = {}) {
  const runtime = path.join(root, '.runtime', 'voice-service');
  const lock = path.join(runtime, 'ui-launch.lock');
  const metadata = path.join(lock, 'process.json');
  const logFile = path.join(runtime, 'ui-service.log');
  let launchError = '';
  const owned = () => {
    try {
      const info = JSON.parse(fs.readFileSync(metadata, 'utf8'));
      if (Number.isInteger(info.pid) && info.pid > 0 && alive(info.pid)) return info;
    } catch {}
    return null;
  };
  async function status() {
    let error = '';
    try {
      const key = fs.readFileSync(path.join(runtime, 'api_key.txt'), 'utf8').trim();
      const response = await http('http://127.0.0.1:9880/v1/capabilities', {
        headers: { Authorization: `Bearer ${key}` }, redirect: 'error', signal: AbortSignal.timeout(2000)
      });
      if (!response.ok) throw new Error(`服务返回 HTTP ${response.status}，请检查本地服务配置`);
      const capabilities = await response.json();
      const voice = capabilities.tts?.find(v => v.voice === 'feiyu' && v.available);
      if (!voice) throw new Error('服务已连接，但肥鱼模型不可用');
      return { state: 'ready', running: false, disabledActions: ['start'], pollAfterMs: 5000,
        message: `🟢 本地语音服务可用 · ${voice.runtime_backend || '本地'}\n声线：${(voice.styles || []).join('、')}\n插件启用和服务运行是独立状态；关闭 QQ agent 后服务仍在后台运行。` };
    } catch (e) { error = e.code === 'ENOENT' ? '缺少本地语音服务密钥或部署文件' : e.message; }
    const processInfo = owned();
    if (processInfo) {
      const timedOut = now() - processInfo.startedAt > 600000;
      return { state: timedOut ? 'error' : 'starting', running: !timedOut, disabledActions: ['start'], pollAfterMs: 2000,
        message: timedOut ? `🔴 启动超过10分钟，尚未就绪；进程仍在运行，避免重复启动。\n请检查日志：${logFile}`
          : `🟡 正在启动本地语音服务，校验并加载模型…\n就绪后会自动更新。日志：${logFile}` };
    }
    if (platform !== 'darwin') return { state: 'offline', running: false, disabledActions: ['start'], pollAfterMs: 5000,
      message: `🔴 本地语音服务未连接。\n${error}\n此平台需要手动部署并启动肥鱼服务（127.0.0.1:9880），MLX 启动器仅支持 Mac。\n部署说明：doc/windows-sync.md` };
    return { state: launchError ? 'error' : 'offline', running: false, pollAfterMs: 5000,
      message: `🔴 本地语音服务未连接，暂时无法合成新语音。\n${launchError || error}\n点击“启动本地语音服务”；已有模型会直接加载，无需重新下载。\n启动日志：${logFile}` };
  }
  async function start() {
    const current = await status();
    if (current.state === 'ready' || owned() || platform !== 'darwin') return current;
    fs.mkdirSync(runtime, { recursive: true });
    // A directory lock also prevents double launches across plugin hot reloads.
    try { fs.mkdirSync(lock); }
    catch (e) {
      if (e.code !== 'EEXIST') throw e;
      if (owned() || now() - fs.statSync(lock).mtimeMs < 10000) return status();
      fs.rmSync(lock, { recursive: true, force: true });
      try { fs.mkdirSync(lock); } catch { return status(); }
    }
    launchError = '';
    let fd;
    try {
      const script = path.join(root, 'macos', 'start.sh');
      fs.accessSync(script, fs.constants.R_OK);
      fd = fs.openSync(logFile, 'a', 0o600);
      // Fixed executable and arguments; neither model text nor settings enter a shell command.
      const child = spawnProcess('/bin/zsh', [script], { cwd: root, detached: true, stdio: ['ignore', fd, fd] });
      child.once('error', () => { launchError = '服务进程启动失败，请检查启动日志'; });
      if (!child.pid) throw new Error('无法创建语音服务进程');
      const info = { pid: child.pid, startedAt: now() };
      fs.writeFileSync(metadata, JSON.stringify(info), { mode: 0o600 });
      const cleanup = (message) => {
        try {
          if (JSON.parse(fs.readFileSync(metadata, 'utf8')).pid !== info.pid) return;
          fs.rmSync(lock, { recursive: true, force: true });
          launchError = message;
        } catch {}
      };
      child.once('error', () => cleanup('服务进程启动失败，请检查启动日志'));
      child.once('exit', (code) => cleanup(`服务进程已退出（${code ?? '信号终止'}），请检查启动日志`));
      child.unref();
    } catch (e) {
      launchError = `启动失败：${e.message}`;
      fs.rmSync(lock, { recursive: true, force: true });
    } finally { if (fd !== undefined) fs.closeSync(fd); }
    return status();
  }
  return { status, start };
}

const serviceControl = createServiceControl(process.env.QQ_AGENT_FEIYU_ROOT || fileURLToPath(new URL('../../../feiyu/', import.meta.url)));
export const settingsActions = {
  actions: [{ id: 'start', label: '启动本地语音服务' }, { id: 'refresh', label: '重新检测服务' }],
  status: () => serviceControl.status(),
  run: (action) => {
    if (action === 'start') return serviceControl.start();
    if (action === 'refresh') return serviceControl.status();
    throw new Error('未知语音服务操作');
  }
};
