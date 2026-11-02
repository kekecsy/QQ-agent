import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config.js';
import { visibleMessages } from './history-policy.js';

export function invalidateHiddenSources(key, messages) {
  const visible = new Set(visibleMessages(key, messages).map((m) => m.id));
  const name = key.replace(':', '_');
  const ids = new Set();
  const summaries = path.join(DATA_DIR, 'daily-summaries', name);
  if (fs.existsSync(summaries)) {
    for (const entry of fs.readdirSync(summaries).filter((n) => /^\d{4}-\d{2}-\d{2}\.json$/.test(n))) {
      const value = JSON.parse(fs.readFileSync(path.join(summaries, entry), 'utf8'));
      for (const [id] of value.sources || []) if (!visible.has(id)) ids.add(id);
    }
  }
  const memes = path.join(DATA_DIR, 'memes', `${name}.json`);
  if (fs.existsSync(memes)) {
    const value = JSON.parse(fs.readFileSync(memes, 'utf8'));
    for (const entry of value.entries || []) for (const source of entry.sources || []) if (!visible.has(source.localId)) ids.add(source.localId);
  }
  invalidateDerivedHistory(name, ids);
}

export function invalidateDerivedHistory(name, ids) {
  if (!ids.size) return;
  const atomic = (file, value) => {
    fs.writeFileSync(`${file}.tmp`, JSON.stringify(value, null, 2));
    fs.renameSync(`${file}.tmp`, file);
  };
  const summaries = path.join(DATA_DIR, 'daily-summaries', name);
  if (fs.existsSync(summaries)) {
    for (const entry of fs.readdirSync(summaries).filter((n) => /^\d{4}-\d{2}-\d{2}\.json$/.test(n))) {
      const file = path.join(summaries, entry);
      const value = JSON.parse(fs.readFileSync(file, 'utf8'));
      if ((value.sources || []).some(([id]) => ids.has(id))) atomic(file, { ...value, text: '', sources: [], sourceMessageIds: [], invalidated: true });
    }
  }
  const memes = path.join(DATA_DIR, 'memes', `${name}.json`);
  if (fs.existsSync(memes)) {
    const data = JSON.parse(fs.readFileSync(memes, 'utf8'));
    let changed = false;
    for (const entry of data.entries || []) {
      if ((entry.sources || []).some((s) => ids.has(s.localId))) {
        Object.assign(entry, { invalidated: true, meaning: '', usage: '', evidenceQuote: '' });
        changed = true;
      }
    }
    if (changed) atomic(memes, data);
  }
}
