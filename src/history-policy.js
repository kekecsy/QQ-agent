import { getConfig } from './config.js';
import { getGlobalBlocklist } from './community.js';
export function visibleMessages(chatKey, messages) {
  const cfg = getConfig();
  const [kind, id] = chatKey.split(':');
  const blocked = new Set([...getGlobalBlocklist(), ...(kind === 'group' ? cfg.blocklist?.[id] || [] : [])].map(String));
  return messages.filter((m) => !m.recalled && !m.isPoke && (m.self || !blocked.has(String(m.senderId))));
}
