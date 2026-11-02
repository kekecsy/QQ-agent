import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config.js';

const file = path.join(DATA_DIR, 'ygo-ruling', 'cards.json');
const normalize = (s) => String(s || '').replace(/\s+/g, '').toLowerCase();
const aliases = ['cn_name', 'sc_name', 'md_name', 'nwbbs_n', 'cnocg_n', 'jp_name', 'en_name', 'wiki_en'];
let cache = null;
let stamp = '';

export function normalizeCardFilters(filters = {}) {
  const out = {};
  if (filters.attribute !== undefined) {
    if (typeof filters.attribute !== 'string') throw new Error('attribute 必须是属性名称');
    out.attribute = filters.attribute.trim().replace(/属性$/, '');
    if (!['地', '水', '炎', '风', '光', '暗', '神'].includes(out.attribute)) throw new Error('attribute 只能是地、水、炎、风、光、暗、神');
  }
  if (filters.race !== undefined) {
    if (typeof filters.race !== 'string') throw new Error('race 必须是种族名称');
    out.race = filters.race.trim().replace(/族$/, '');
    if (!/^[\u3400-\u9fff]{1,8}$/.test(out.race)) throw new Error('race 请用中文种族名称，如岩石族、战士族');
  }
  for (const key of ['level', 'levelMin', 'levelMax']) {
    if (filters[key] === undefined) continue;
    const value = filters[key];
    if (!Number.isInteger(value) || value < 1 || value > 13) throw new Error(`${key} 必须是1–13的整数`);
    out[key] = value;
  }
  if ((out.levelMin ?? 1) > (out.levelMax ?? 13)
    || (out.level !== undefined && (out.level < (out.levelMin ?? 1) || out.level > (out.levelMax ?? 13)))) {
    throw new Error('星级条件冲突，请核对 level、levelMin、levelMax');
  }
  if (filters.effectKeywords !== undefined) {
    if (!Array.isArray(filters.effectKeywords) || filters.effectKeywords.length > 8
      || filters.effectKeywords.some(k => typeof k !== 'string' || !k.trim() || k.length > 80)) {
      throw new Error('effectKeywords 必须是最多8个非空短关键词组成的数组');
    }
    if (filters.effectKeywords.length) out.effectKeywords = [...new Set(filters.effectKeywords.map(k => k.trim()))];
  }
  return out;
}

function matchesFilters(card, filters) {
  const types = String(card.text?.types || '');
  const identity = types.match(/\]\s*([^/\n]+)\/([^/\n\[]+)/);
  if (filters.race && identity?.[1].trim().replace(/族$/, '') !== filters.race) return false;
  if (filters.attribute && identity?.[2].trim().replace(/属性$/, '') !== filters.attribute) return false;
  if (filters.level !== undefined || filters.levelMin !== undefined || filters.levelMax !== undefined) {
    // XYZ ranks and Link ratings share data.level, but they are not monster levels.
    if (!types.includes('怪兽') || /超量|连接/.test(types)) return false;
    const level = card.data?.level !== undefined ? Number(card.data.level) & 0xff : Number(types.match(/★(\d+)/)?.[1]);
    if (!Number.isInteger(level) || level < 1
      || (filters.level !== undefined && level !== filters.level)
      || level < (filters.levelMin ?? 1) || level > (filters.levelMax ?? 13)) return false;
  }
  if (!filters.effectKeywords) return true;
  const effect = normalize(`${card.text?.pdesc || ''}\n${card.text?.desc || ''}`).replaceAll('手牌', '手卡');
  return filters.effectKeywords.every(k => effect.includes(normalize(k).replaceAll('手牌', '手卡')));
}

// null means no usable local database; [] means a valid local search with no match.
export function queryLocalCards(keyword, filters = {}, limit = 100) {
  const constraints = normalizeCardFilters(filters);
  try {
    const stat = fs.statSync(file);
    const nextStamp = `${stat.ino}:${stat.mtimeMs}:${stat.ctimeMs}:${stat.size}`;
    if (stamp !== nextStamp) {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (!raw || Array.isArray(raw) || typeof raw !== 'object') return null;
      const next = Object.entries(raw).filter(([, c]) => c && (c.id || c.cid) && c.text)
        .map(([cid, c]) => ({ card: { ...c, cid: c.cid || cid }, names: aliases.map((key) => normalize(c[key])) }));
      if (!next.length) return null;
      cache = next;
      stamp = nextStamp;
    }
    const q = normalize(keyword);
    if (!q && !Object.keys(constraints).length) return [];
    const exact = [];
    const partial = [];
    for (const item of cache) {
      const c = item.card;
      if (!matchesFilters(c, constraints)) continue;
      if (q && (String(c.id) === q || String(c.cid) === q || item.names.includes(q))) exact.push(c);
      else if (!q || item.names.some((name) => name.includes(q))) partial.push(c);
    }
    return [...exact, ...partial].slice(0, limit);
  } catch { return null; }
}

export function localCardDatabaseVersion() {
  try {
    const stat = fs.statSync(file);
    return `${stat.ino}:${stat.mtimeMs}:${stat.ctimeMs}:${stat.size}`;
  } catch { return ''; }
}
