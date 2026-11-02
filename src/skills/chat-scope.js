import { AsyncLocalStorage } from 'node:async_hooks';

const execution = new AsyncLocalStorage();
export const currentExtensionContext = () => execution.getStore() || {};
export const withExtensionContext = (context, fn) => execution.run({ ...currentExtensionContext(), ...context }, fn);

export function normalizeChatScope(value) {
  if (!value || !['all', 'only', 'except'].includes(value.mode) || !Array.isArray(value.chats)) {
    throw new Error('会话范围必须包含 mode（all/only/except）和 chats 数组');
  }
  if (value.chats.length > 2000 || value.chats.some((key) => typeof key !== 'string' || !/^(group|private):[1-9]\d*$/.test(key))) {
    throw new Error('会话范围只能使用 group:群号 或 private:QQ号，最多2000项');
  }
  return { mode: value.mode, chats: [...new Set(value.chats)] };
}

export function extensionAllowsChat(settings, chatKey) {
  // Account-level services have no destination chat; their global switch still applies.
  if (!chatKey || !settings?.chatScope) return true;
  let scope;
  try { scope = normalizeChatScope(settings.chatScope); }
  catch { return false; }
  const selected = scope.chats.includes(String(chatKey));
  return scope.mode === 'all' || (scope.mode === 'only' ? selected : !selected);
}
