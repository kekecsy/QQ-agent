export function parseYgoCommand(text) {
  const match = /^(查卡|裁定) +([^\s][\s\S]*)$/.exec(String(text ?? ''));
  return match ? { command: match[1], content: match[2].trimEnd() } : null;
}
