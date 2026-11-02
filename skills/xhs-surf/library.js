import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { ROOT } from './service.js';

export function loadState() {
  try { return JSON.parse(fs.readFileSync(path.join(ROOT, 'library.json'), 'utf8')); }
  catch (e) { if (e.code === 'ENOENT') return { notes: [], images: [], posts: {}, lastSurfAt: 0 }; throw e; }
}
export function saveState(state) {
  fs.mkdirSync(ROOT, { recursive: true, mode: 0o700 });
  const file = path.join(ROOT, 'library.json');
  fs.writeFileSync(file + '.tmp', JSON.stringify(state, null, 2), { mode: 0o600 });
  fs.renameSync(file + '.tmp', file);
}
export function chinaClock(now = Date.now()) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(now);
  const p = Object.fromEntries(parts.map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour), minute: Number(p.minute) };
}
export function publishDue(state, settings, now = Date.now()) {
  const clock = chinaClock(now);
  return settings.autoPost === true && clock.hour === 21 && clock.minute < 10 && !state.posts[clock.date];
}
export function parseAnalysis(value) {
  const parsed = JSON.parse(String(value).trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, ''));
  const confidence = Number(parsed.confidence);
  if (typeof parsed.suitable !== 'boolean' || typeof parsed.aiRelated !== 'boolean' || !Number.isFinite(confidence) || confidence < 0 || confidence > 1) throw new Error('视觉模型未返回完整的表情适用性判断');
  return { meaning: String(parsed.meaning || '').slice(0, 600), name: String(parsed.name || '').slice(0, 60), suitable: parsed.suitable, aiRelated: parsed.aiRelated, confidence };
}
export function canCollect(note, analysis) {
  return collectionReasons(note, analysis).length === 0;
}
export function collectionReasons(note, analysis) {
  const reasons = [];
  if (analysis.aiRelated !== true) reasons.push('未确认是AI相关角色或梗图');
  if (analysis.suitable !== true) reasons.push('模型认为不适合当聊天表情');
  if (!analysis.name || !analysis.meaning) reasons.push('缺少可用的表情名称或含义');
  if (!(analysis.confidence >= 0.7)) reasons.push('图片内容判断不够可靠');
  return reasons;
}

export function readingHistory(state, limit = 20) {
  return state.notes.slice(-limit).reverse().map((n) => ({
    title: n.title, source: n.source, readAt: n.readAt,
    understanding: (n.meanings || []).map((m) => m.meaning).join('；').slice(0, 450),
    checks: n.imageChecks || (n.meanings || []).filter((m) => !m.textOnly).map((m) => ({
      status: m.collected ? 'collected' : 'skipped',
      reasons: m.collected ? [] : [...(m.watermark === null ? ['视觉模型无法确认是否有水印'] : []), '旧记录未保留全部检查细节；未收藏成功']
    })),
    legacy: !n.imageChecks,
    oldCollectionPolicy: n.collectionPolicy !== 'suitability-v2',
    commentCount: n.commentCount || 0,
    qqCollected: state.images.filter((i) => i.noteId === n.id && i.qqEmojiId).length,
    lastRetryError: n.lastRetryError || '',
    retryable: retryableNote(n)
  }));
}

export function retryableNote(note) {
  if (note.noteType === 'video') return false;
  if (note.collectionPolicy !== 'suitability-v2' && (note.imageChecks?.some((c) => c.status !== 'collected') || (note.meanings || []).some((m) => !m.textOnly && !m.collected))) return true;
  if ((note.imageChecks || []).some((c) => c.status === 'failed')) return true;
  if (!note.imageChecks) return (note.meanings || []).some((m) => !m.textOnly && m.watermark === null && !m.collected);
  return false;
}

export function selectRetryNotes(state, limit = 3) {
  const rank = (n) => n.imageChecks?.some((c) => c.status === 'failed') ? 0 : 1;
  return state.notes.filter(retryableNote)
    .sort((a, b) => rank(a) - rank(b) || (a.lastRetryAt || 0) - (b.lastRetryAt || 0) || (a.readAt || 0) - (b.readAt || 0))
    .slice(0, Math.min(3, Math.max(1, limit)));
}

export function upsertNote(state, observation) {
  const index = state.notes.findIndex((n) => n.id === observation.id);
  if (index < 0) state.notes.push(observation);
  else state.notes[index] = observation;
}

export function publicComments(note, comments) {
  const authorId = String(note.user?.userId || '');
  return (Array.isArray(comments?.list) ? comments.list : []).slice(0, 10).map((c) => ({
    text: String(c.content || '').replace(/\s+/g, ' ').slice(0, 180),
    authorIsPoster: !!authorId && String(c.userInfo?.userId || '') === authorId
  })).filter((c) => c.text);
}
export function saveImage(buffer, ext) {
  const id = createHash('sha256').update(buffer).digest('hex');
  fs.mkdirSync(path.join(ROOT, 'images'), { recursive: true });
  const file = path.join(ROOT, 'images', `${id}.${ext}`);
  fs.writeFileSync(file, buffer);
  return { id, filename: `${id}.${ext}` };
}
export function readImage(entry) {
  if (!/^[a-f0-9]{64}\.(png|jpg|webp)$/.test(entry.filename || '')) throw new Error('图片缓存路径不合法');
  return fs.readFileSync(path.join(ROOT, 'images', entry.filename));
}
