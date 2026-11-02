import { recoveryCandidates } from '../../src/message-recovery.js';
import { listSendFailures } from '../../src/send-failures.js';
import { visibleMessages } from '../../src/history-policy.js';

export function promptSections() {
  return [{ id: 'message-recovery-guide', title: '提醒后补看', priority: 40, content: '不主动巡查或补回复旧消息。只有群友再次提到、提醒没回复或要求重看时，才用 message-recovery__get_recovery_messages / get_recent_messages 查对应记录，再按需 get_message_images 补看；先核对后续对话，已经明确回答的即使措辞不同也不要重复回。失败记录只是查询线索，不是待办清单。只补协议明确失败的原文，不整批重发已成功部分；超时或回执不明不自动重发。' }];
}

export const providers = { 'message.recovery-query': (ctx) => recoveryCandidates(ctx.store, ctx.chatKey) };

export function setup(api) {
  api.registerTool({
    id: 'get_recovery_messages', name: '查看待补看消息', category: 'query',
    description: '仅在群友提醒后查询本会话最近12小时失败回复/未识别图片，最多3条候选；先核对后续聊天，选择性补看，不自动发送。',
    parameters: { type: 'object', properties: {} },
    async execute(ctx) {
      try {
        const failures = listSendFailures(ctx.chatKey).filter((f) => f.sourceMids.length && f.sourceMids.every((mid) => {
          const entry = ctx.store.findByMid(ctx.chatKey, mid);
          return entry && visibleMessages(ctx.chatKey, [entry]).length;
        }));
        return { content: JSON.stringify({
          failedSends: failures.slice(-10).map((f) => ({ id: f.id, text: f.text, types: f.types, sourceMids: f.sourceMids })),
          messages: recoveryCandidates(ctx.store, ctx.chatKey).map((m) => ({ messageId: m.mid, time: new Date(m.ts).toISOString(), sender: m.senderName, text: String(m.text).slice(0, 500), visualSummary: m.visualSummary || undefined })),
          note: '同一内容确认发送成功后自动清除失败记录；候选不是待办清单，已经回答的不要重复回。'
        }) };
      } catch (error) { return { content: `补看查询失败：${error.message}`, isError: true }; }
    }
  });
}
