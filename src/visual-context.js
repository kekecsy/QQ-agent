// Compact legacy verbose observations locally, without another model request.
export function compactVisualSummary(value, maxChars = 220) {
  if (maxChars <= 0) return '';
  const text = String(value || '').replace(/\*\*/g, '').replace(/[ \t]+/g, ' ').trim();
  const label = text.match(/^第\s*\d+\s*张[：:]/)?.[0];
  if (label) return (label + compactVisualSummary(text.slice(label.length), Math.max(0, maxChars - label.length))).slice(0, maxChars);
  if (text.length <= maxChars) return text.replace(/\s+/g, ' ');
  const sentences = text.split(/\n+|(?<=[。！？])\s*/).map((s) => s.trim()).filter(Boolean);
  const ranked = sentences.map((sentence, index) => ({ sentence, index,
    score: /文字|写着|台词|Claude|DeepSeek|小鲸鱼|ChatGPT|身份|看不清|失败|首帧|水印|纠正/i.test(sentence) ? 3 : /人物|表情|动作|反差|总结/.test(sentence) ? 2 : index === 0 ? 1 : 0
  })).sort((a, b) => b.score - a.score || a.index - b.index);
  const chosen = [];
  let used = 0;
  for (const item of ranked) {
    const available = maxChars - used - (chosen.length ? 1 : 0);
    if (available < 20) break;
    const sentence = item.sentence.slice(0, Math.min(120, available));
    chosen.push({ ...item, sentence }); used += sentence.length + (chosen.length > 1 ? 1 : 0);
  }
  return chosen.sort((a, b) => a.index - b.index).map((s) => s.sentence).join(' ').slice(0, maxChars);
}
