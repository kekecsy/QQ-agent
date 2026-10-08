// forward-relay 的状态文件（原子写 + 延迟合并落盘 + 损坏留证）。
//
// 为什么不用 src/store.js 那套：那是"聊天存档"，一条一条 push 的形态，
// 而这里要的是一整份可读写的状态对象（指纹索引 / 待处理清单 / 已处理 mid）。
// 实现照抄 plugins/file-edit/lib/store.js 的经验：
//   · 先写 `.tmp` 再 rename —— 断电/崩溃不会留下半截 JSON（会读到脏状态）；
//   · JSON 解析失败改名 `*.bad-<ts>` 留证 —— 别静默清空，出问题时还能查；
//   · touch(ms) 延迟写 —— 一次扫描可能改十几处，逐次写盘纯属自残（最大那份群档案 7.6MB）；
//   · flush() 在 deactivate / dispose 时调，保证热重载不丢状态。

import fs from 'node:fs';
import path from 'node:path';

export function createStore(file, { onWarn = () => {} } = {}) {
  let data = {};
  let timer = null;
  let dirty = false;

  function load() {
    try {
      const raw = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
      const parsed = JSON.parse(raw);
      data = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch (error) {
      // 文件不存在 = 第一次跑（正常）；存在却读不动 = 坏了，改名留证再从头开始
      if (fs.existsSync(file)) {
        try { fs.renameSync(file, `${file}.bad-${Date.now()}`); } catch { /* 留证失败也不阻断启动 */ }
        onWarn(`状态文件损坏，已改名留证：${error?.message ?? error}`);
      }
      data = {};
    }
    return data;
  }

  function writeNow() {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const tmp = `${file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(data), 'utf8');
      fs.renameSync(tmp, file);
      dirty = false;
    } catch (error) {
      onWarn(`状态写盘失败：${error?.message ?? error}`);
    }
  }

  function schedule(delayMs) {
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      if (dirty) writeNow();
    }, Math.max(0, Number(delayMs) || 0));
    timer.unref?.();
  }

  /** 标脏并排一次写盘（默认 800ms 后合并写）。 */
  function touch(delayMs = 800) {
    dirty = true;
    if (delayMs <= 0) {
      if (timer) { clearTimeout(timer); timer = null; }
      writeNow();
      return;
    }
    schedule(delayMs);
  }

  /** 立刻落盘（没有改动就什么都不做）。 */
  function flush() {
    if (timer) { clearTimeout(timer); timer = null; }
    if (dirty) writeNow();
  }

  return {
    get data() { return data; },
    get dirty() { return dirty; },
    load,
    touch,
    flush,
    writeNow
  };
}
