import { assertMutationFence } from '../core/mutation-fence.js';
import { err, ok, unknownToolOutcome, type ToolContext, type ToolResult } from '../core/tool.js';
import { parseProjectMemoryInput } from '@mcp/shared/memory-write.js';

export async function invokeOwnedMemorySave(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  if (!ctx.ports?.memoryMutations) return err('Native memory save requires its owned persistence port.');
  let entry;
  try {
    entry = parseProjectMemoryInput(args); ctx.signal?.throwIfAborted();
    assertMutationFence(ctx.mutationFence, { kind: 'database', resource: 'memory:project', operation: 'save_memory.save' });
  } catch (error) { return err(`Memory save rejected before dispatch: ${error instanceof Error ? error.message : error}`); }
  try {
    const result = await ctx.ports.memoryMutations.invoke({ toolName: 'mcp__save_memory', input: ctx.currentToolInvocation?.input ?? args,
      toolUseId: ctx.currentToolUseId, binding: ctx.mutationFence?.resourceBinding, signal: ctx.signal });
    if (!result || !('created' in result)) throw new Error('Missing memory write receipt');
    return ok(`Memory "${entry.title}" ${result.merged > 0 ? 'merged into existing memory' : result.created > 0 ? 'saved' : 'skipped'} (created=${result.created} merged=${result.merged}).`);
  } catch { return unknownToolOutcome('Memory save lost confirmation. Reconcile the original memory before authorizing another mutation.'); }
}
