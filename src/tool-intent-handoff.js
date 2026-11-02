// A final sending decision is a plan, not a tool call. Ask the model to execute it
// once; never extract reply text or invent sticker arguments from the plan.
export function hasUnexecutedSendDecision(text) {
  const lastParagraph = String(text || '').trim().split(/\n\s*\n/).at(-1)?.trim() || '';
  if (!lastParagraph || lastParagraph.length > 400) return false;
  // Ambivalence or an explicit decision to stay silent is not a send commitment.
  if (/不(?:再|用|必|要)?(?:发|回|接)|沉默|安静结束|直接结束|无需回复|或者|也可以|要不要|是否|考虑/.test(lastParagraph)) return false;
  return /(?:^|[。！？；\n])\s*(?:好[，,]\s*)?(?:我)?(?:选择|决定|最终决定|最后决定|准备|打算|现在就|先|就)(?:\s|[：:，,]|我|直接|还是|只|先|就|用工具|调用)*(?:发(?:送|个|一|张|条|文字|消息|表情|GIF)|回(?:复|个|一|张|条))/.test(lastParagraph);
}

// A private conversation is addressed to the bot. Nonempty final text may be a
// reply accidentally written outside a tool; ask for a tool decision once. This
// does not deliver the text, and finish remains a valid choice.
export function shouldHandoffUnsentReply(text, { isPrivate = false } = {}) {
  if (hasUnexecutedSendDecision(text)) return true;
  const body = String(text || '').trim();
  if (!isPrivate || !body) return false;
  if (/不(?:再|用|必|要)?(?:发|回|接)|沉默|安静结束|直接结束|无需回复/.test(body)) return false;
  return true;
}

export const TOOL_HANDOFF_REMINDER = '【工具执行提醒】本轮尚未调用发送工具，刚才的普通文本不会发到QQ。如果其中有要说给对方的回复，请现在调用本次可用的发送工具；不要只在正文里写回复或复述计划，参数必须有依据。看不到的QQ表情不能猜具体含义；若重新判断无需回复、依据不足或没有合适工具，请调用 finish 安静结束。不要把思考过程发送给群友。';
