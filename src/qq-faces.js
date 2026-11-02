import fs from 'node:fs';

// Offline snapshot of QQ's own system-face names. Keep the OneBot face ID as
// protocol identity; names are for understanding, not guessed visual summaries.
const { faces } = JSON.parse(fs.readFileSync(new URL('../assets/qq-face-names.json', import.meta.url), 'utf8'));

export function qqFaceName(id) {
  const key = String(id ?? '').trim();
  return Object.hasOwn(faces, key) ? faces[key] : '';
}

export function formatQqFace(id) {
  const name = qqFaceName(id);
  return name ? `[QQ表情:${name}]` : `[表情${String(id ?? '')}]`;
}

// Render old stored placeholders without rewriting the original chat archive.
export function describeQqFaces(text) {
  return String(text ?? '').replace(/\[表情(\d+)\]|\[CQ:face,id=(\d+)\]/g,
    (original, legacyId, cqId) => qqFaceName(legacyId ?? cqId) ? formatQqFace(legacyId ?? cqId) : original);
}
