// Optional text renderers run only for replies the model decided to send.
import { skillManager } from './skills/manager.js';
import { withExtensionContext } from './skills/chat-scope.js';

export async function deliverTextReply(ctx, messages, options = {}, manager = skillManager) {
  for (const provider of manager.getCapabilityProviders('message.deliver-text', ctx)) {
    try {
      const result = await withExtensionContext({ chatKey: ctx.chatKey, skillId: provider.skillId },
        () => provider.fn({ ctx, messages, options }));
      if (result?.handled === true && Array.isArray(result.sent) && result.sent.length && Array.isArray(result.failed)) return result;
    } catch (error) {
      manager.recordError(provider.skillId, error);
    }
  }
  return ctx.sender.sendTextBatch(ctx.chatKey, messages, options);
}
