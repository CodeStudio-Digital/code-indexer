import type { ToolContext } from '../core/tool.js';
export function assertSessionDataCurrent(ctx: ToolContext): void {
  ctx.signal?.throwIfAborted();
  ctx.sessionDrive?.assertCurrent?.();
  ctx.conversationHistory?.assertCurrent?.();
}
