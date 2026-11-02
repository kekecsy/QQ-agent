import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from '../../src/config.js';

const root = path.join(DATA_DIR, 'ygo-ruling', 'rule-study');
let cache;

export function searchRuleBook(keywords, limit = 5, chapter = '') {
  const terms = [...new Set((Array.isArray(keywords) ? keywords : []).map((s) => String(s).trim()).filter((s) => s.length >= 2 && s.length <= 80))].slice(0, 8);
  if (!terms.length) return { content: '请给出2字以上的规则关键词，例如“发动无效并破坏”“场上”。', isError: true };
  try {
    const dirs = fs.readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort().reverse();
    const folder = dirs.find((n) => fs.existsSync(path.join(root, n, 'manifest.json')) && fs.existsSync(path.join(root, n, 'source-blocks.json')));
    if (!folder) throw new Error('not installed');
    const file = path.join(root, folder, 'source-blocks.json');
    const stat = fs.statSync(file);
    const stamp = `${file}:${stat.ino}:${stat.mtimeMs}:${stat.size}`;
    if (cache?.stamp !== stamp) cache = { stamp, blocks: JSON.parse(fs.readFileSync(file, 'utf8')) };
    const section = String(chapter || '').trim();
    if (section && !/^\d+(?:\.\d+)*$/.test(section)) return { content: '章节号应为3.6、4.9等数字格式。', isError: true };
    const seen = new Set();
    const matches = cache.blocks.filter((b) => /^[2-9]\./.test(b.chapter) && b.type !== 'image' && (section ? b.chapter.startsWith(`${section} `) || b.chapter.startsWith(`${section}.`) : !/^6\./.test(b.chapter))).map((b) => {
      const text = b.text.replace(/\s+/g, '');
      const hits = terms.filter((t) => text.includes(t.replace(/\s+/g, '')));
      return { block: b, hits, score: hits.length * 100 + hits.reduce((n, t) => n + t.length, 0) };
    }).filter((m) => {
      const text = m.block.text.replace(/\s+/g, '');
      if (!m.hits.length || seen.has(text)) return false;
      seen.add(text); return true;
    }).sort((a, b) => b.score - a.score).slice(0, Math.min(8, Math.max(1, Number(limit) || 5)));
    if (!matches.length) return { content: '本地规则资料没有命中这些词。请换核心词；未命中不表示规则不存在。' };
    const header = `【本地规则资料原文检索】社区规则参考，非官方裁定全集；摘要未必审核。以下是原文摘录而非模型历史答案，页码为PDF物理页。关键词部分命中不代表符合当前场景，请核对前提、例外及具体卡文。资料批次：${folder}。`;
    const text = matches.map(({ block: b, hits }) => `【${b.id}】${b.chapter} · 第${b.part}册PDF第${b.localPdfPage}页（合并第${b.globalPdfPage}页）· 命中：${hits.join('、')}\n${b.text.slice(0, 1200)}${b.text.length > 1200 ? '\n（此段截取，未显示部分不能推断）' : ''}`).join('\n\n');
    return { content: `${header}\n\n${text}` };
  } catch { return { content: '本地规则原文索引尚未安装或读取失败；请先完成规则资料导入，不要假装已查阅。', isError: true }; }
}
