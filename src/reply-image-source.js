// Follow only messages already visible in this chat. Never guess a source from
// quoted prose or import a remote message from a different chat.
export async function replyImageSource(ctx, initial) {
  let entry = initial;
  const seen = new Set();
  for (let depth = 0; depth < 4; depth++) {
    if ((entry.media || []).some(m => m.kind === 'image' && m.url)) return { entry };
    const key = String(entry.mid);
    if (seen.has(key)) return { entry: initial, error: '引用消息存在循环，无法定位图片' };
    seen.add(key);
    let replyId = entry.reply?.messageId ?? entry.reply?.mid;
    if (replyId == null && /^\[引用/.test(String(entry.text || '')) && ctx.onebot?.getMsg) {
      try {
        const raw = await ctx.onebot.getMsg(entry.mid);
        const group = String(ctx.chatKey).startsWith('group:') ? String(ctx.chatKey).slice(6) : null;
        if (group && raw?.group_id != null && String(raw.group_id) !== group) return { entry: initial, error: '引用消息与当前会话不匹配' };
        replyId = Array.isArray(raw?.message) ? raw.message.find(s => s.type === 'reply')?.data?.id : null;
      } catch { return { entry: initial, error: '引用原消息暂时无法查询，不能从文字占位符猜测图片' }; }
    }
    if (replyId == null) return { entry };
    const source = ctx.store.findByMid(ctx.chatKey, replyId);
    if (!source || ctx.isVisible?.(source) === false) return { entry: initial, error: `本条是引用消息，原消息 #${replyId} 不在当前可见历史中，无法获取原图` };
    entry = source;
  }
  return { entry: initial, error: '引用层数过多，请提供图片原消息的编号' };
}
