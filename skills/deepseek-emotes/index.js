import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { ROOT, DATA_DIR } from '../../src/config.js';

let config = () => ({});
const stateFile = path.join(DATA_DIR, 'deepseek-emotes', 'usage.json');
const locks = new Set();
let indexCache = { signature: '', items: [], summary: '' };
const synonyms = [
  ['开心', '高兴', '庆祝', '耶', '舞蹈', '唱歌'],
  ['生气', '愤怒', '气鼓鼓', '打字(生气)'],
  ['晚安', '困', '睡觉', '小睡', '枕头'],
  ['思考', '认真', '疑问', '书呆子'],
  ['赞', '认可', '支持', '点赞', '一切都好'],
  ['伤心', '委屈', '难过', '哭', '自我安慰'],
  ['害怕', '吓', '惊吓', '害羞'],
  ['喜欢', '谢谢', '感谢', '爱心', '礼物', '摸头'],
  ['馋', '吃饭', '饿', '筷子'],
  ['无语', '呆', '头晕', '静音', '叹号'],
  ['摸鱼', '上班', '工作', '打字', '带薪拉屎'],
  ['期待', '等', '加载']
];
const normalize = (s) => String(s || '').trim().toLowerCase().replace(/\s+/g, '');
const shortName = (s) => String(s).replace(/\s*\d+$/, '').trim();
function assetDirectory() {
  const configured = String(config().assetDir || '').trim();
  let dir;
  if (configured) dir = path.isAbsolute(configured) ? configured : path.resolve(ROOT, configured);
  else {
    const parent = path.dirname(ROOT);
    const packs = fs.readdirSync(parent).filter((n) => n.startsWith('deepseek-chan-emotes-') && fs.statSync(path.join(parent, n)).isDirectory()).sort();
    if (!packs.length) throw new Error('未找到本地 GIF 图库，请在技能设置填写图库目录');
    dir = path.join(parent, packs.at(-1));
  }
  return fs.existsSync(path.join(dir, 'gifs')) ? path.join(dir, 'gifs') : dir;
}
export function catalog() {
  const dir = assetDirectory();
  const signature = `${dir}:${fs.statSync(dir).mtimeMs}`;
  if (indexCache.signature === signature) return indexCache.items;
  const items = fs.readdirSync(dir).filter((n) => /\.gif$/i.test(n) && fs.lstatSync(path.join(dir, n)).isFile()).sort().map((file) => ({
    id: createHash('sha256').update(file).digest('hex').slice(0, 12),
    name: file.replace(/^deepseek娘_/, '').replace(/_\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2}\.gif$/i, ''),
    file: path.join(dir, file)
  }));
  const groups = new Map();
  for (const item of items) {
    const group = synonyms.find((terms) => terms.some((term) => normalize(item.name).includes(normalize(term))))?.[0] || '其他动作';
    if (!groups.has(group)) groups.set(group, []);
    groups.get(group).push(shortName(item.name));
  }
  const summary = [...groups].map(([label, names]) => `${label}：${[...new Set(names)].join('、')}`).join('\n');
  indexCache = { signature, items, summary };
  // This is a generated filename index, not a vision-model description.
  try {
    const indexDir = path.join(DATA_DIR, 'deepseek-emotes');
    fs.mkdirSync(indexDir, { recursive: true });
    fs.writeFileSync(path.join(indexDir, 'catalog-summary.json'), JSON.stringify({ source: 'filename-labels', count: items.length, summary, entries: items.map(({ id, name }) => ({ id, name })) }, null, 2));
  } catch { /* Sending does not depend on writing the optional index. */ }
  return items;
}
export function catalogSummary() { catalog(); return indexCache.summary; }
export function findCandidates(keyword, items = catalog()) {
  const q = normalize(keyword);
  if (!q) return items;
  const terms = new Set([q]);
  for (const group of synonyms) if (group.some((s) => q.includes(normalize(s)))) group.forEach((s) => terms.add(normalize(s)));
  return items.map((item) => ({ ...item, score: [...terms].reduce((score, term) => score + (normalize(item.name).includes(term) ? (term === q ? 10 : 1) : 0), 0) }))
    .filter((item) => item.score > 0).sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
}
function loadUsage() {
  try { return JSON.parse(fs.readFileSync(stateFile, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return {}; throw new Error('表情发送记录损坏，暂不发送以避免刷屏'); }
}
function saveUsage(state) {
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  fs.writeFileSync(`${stateFile}.tmp`, JSON.stringify(state));
  fs.renameSync(`${stateFile}.tmp`, stateFile);
}
const number = (v, fallback, max) => Number.isFinite(Number(v)) ? Math.min(max, Math.max(0, Math.floor(Number(v)))) : fallback;
export async function sendEmote(ctx, args = {}) {
  if (!ctx.chatKey || !ctx.sender?.sendImage) return { content: '当前会话无法发送图片', isError: true };
  if (locks.has(ctx.chatKey)) return { content: '本会话正在发送表情，请勿重复调用', isError: true };
  locks.add(ctx.chatKey);
  try {
    const cfg = config();
    if (cfg.proactive === false && args.requested !== true) throw new Error('主动配图已关闭，仅群友明确要表情时可发送');
    const usage = loadUsage();
    const now = Date.now();
    const records = (usage[ctx.chatKey] || []).filter((r) => now - r.ts < 86400000);
    const gap = number(cfg.cooldownSeconds, 180, 86400) * 1000;
    if (records.length && now - records.at(-1).ts < gap) throw new Error('刚发过表情，本轮不要再配图');
    if (records.filter((r) => now - r.ts < 3600000).length >= number(cfg.maxPerHour, 6, 100)) throw new Error('本会话已达到每小时表情上限');
    if (records.length >= number(cfg.maxPerDay, 30, 500)) throw new Error('本会话已达到24小时表情上限');
    const items = catalog();
    const avoided = new Set(number(cfg.avoidRecent, 8, 100) ? records.slice(-number(cfg.avoidRecent, 8, 100)).map((r) => r.id) : []);
    const named = items.filter((i) => normalize(i.name) === normalize(args.name) || normalize(shortName(i.name)) === normalize(args.name));
    const byId = items.find((i) => i.id === String(args.id || ''));
    const candidates = named.length ? named : (byId ? [byId] : []);
    if (!candidates.length) throw new Error('表情名字不存在，请使用目录中的动作名；不要编造编号');
    const item = candidates.find((i) => !avoided.has(i.id));
    if (!item) throw new Error('这个动作的表情最近发过，请换一个动作或本轮不发');
    const recent = records.slice(-number(cfg.avoidRecent, 8, 100));
    if (number(cfg.avoidRecent, 8, 100) && recent.some((r) => r.id === item.id)) throw new Error('这张表情最近发过，请换候选或不发');
    const stat = fs.statSync(item.file);
    if (stat.size > 20 * 1024 * 1024) throw new Error('GIF 超过20MB，暂不发送');
    const fd = fs.openSync(item.file, 'r');
    const header = Buffer.alloc(6);
    try { fs.readSync(fd, header, 0, 6, 0); } finally { fs.closeSync(fd); }
    if (!['GIF87a', 'GIF89a'].includes(header.toString())) throw new Error('文件不是有效 GIF');
    const bytes = fs.readFileSync(item.file);
    const receipt = await ctx.sender.sendImage(ctx.chatKey, { dataUrl: `base64://${bytes.toString('base64')}` }, { note: `DeepSeek娘：${item.name}` });
    // Refresh after the async send so different chats do not overwrite each other.
    const latest = loadUsage();
    latest[ctx.chatKey] = [...records, { id: item.id, ts: Date.now() }];
    saveUsage(latest);
    return { content: JSON.stringify({ sent: true, name: item.name, messageId: receipt?.message_id ?? null, note: '已发出GIF，本轮不再发图。' }) };
  } catch (error) { return { content: JSON.stringify({ sent: false, reason: error.message, note: '没有发出GIF，不得在回复或finish中宣称发了表情。' }), isError: true }; }
  finally { locks.delete(ctx.chatKey); }
}
export function promptSections() {
  let inventory;
  try { inventory = catalogSummary(); } catch { inventory = '图库不可用，请使用 list_emotes 检查配置。'; }
  return [{ id: 'deepseek-emotes-rules', title: 'DeepSeek娘本地GIF', priority: 45, content:
    `默认优先选本地贴切GIF；群友明确要QQ收藏或指定其他图时尊重指定，没有贴切动作才用QQ收藏。冷却或限额不能换图库绕过。本地GIF按作者动作名选，不看图。直接调用 deepseek-emotes__send_emote，填 name（如“唱歌”“呆”），不填编号，不必先 list_emotes；多个版本由程序选择。不确定名称才查询候选。\n${inventory}\n${config().proactive === false ? '只在群友明确要表情时发送。' : '轻松聊天时偶尔配一张；不合适就不发。'}严肃求助不用表情敷衍，不用暧昧或攻击动作升级气氛。同一轮不叠加其他图库。明确要图才 requested=true。仅 sent=true 表示GIF已送达；sent=false 必须承认未发出，不得在finish里宣称发了图。最近发过时最多换一个动作尝试；冷却、额度或其他失败则停止，不绕过限制。` }];
}
export function setup(api) {
  config = api.config;
  api.registerTool({ id: 'list_emotes', name: '挑选 DeepSeek 娘动图', category: 'media', description: '按情绪/动作搜索本地 GIF。返回真实编号和作者动作名称，先挑贴合语境的表情；找不到不要硬配。', parameters: { type: 'object', properties: { keyword: { type: 'string', description: '如开心、晚安、生气、点赞、思考；留空浏览' }, offset: { type: 'integer', description: '浏览下一页，默认0' } } }, async execute(_ctx, args = {}) {
    try {
      const matches = findCandidates(args.keyword);
      const offset = number(args.offset, 0, 10000);
      const names = [...new Set(matches.map((m) => shortName(m.name)))];
      return { content: JSON.stringify({ total: names.length, candidates: names.slice(offset, offset + 12), nextOffset: offset + 12 < names.length ? offset + 12 : null }) };
    } catch (error) { return { content: error.message, isError: true }; }
  } });
  api.registerTool({ id: 'send_emote', name: '发送 DeepSeek 娘动图', category: 'media', description: '填目录中的简短动作名，发送一张GIF；自动选未重复版本。以返回sent字段判断成功，不填编号。', parameters: { type: 'object', properties: { name: { type: 'string', description: '如唱歌、呆、点赞、睡觉(普通)' }, requested: { type: 'boolean', description: '群友明确要图才true' } }, required: ['name'] }, execute: sendEmote });
}
