import { assertMutationFence } from '../core/mutation-fence.js';
import { err, ok, unknownToolOutcome, type ToolContext, type ToolResult } from '../core/tool.js';

export async function invokeOwnedDocumentExport(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  if (!ctx.ports?.documentExport) return err('Native document export requires its owned persistence port.');
  if (args.format != null && args.format !== 'json' && args.format !== 'markdown') return err('Invalid export format');
  if (args.sections != null && (!Array.isArray(args.sections) || args.sections.length > 6
    || args.sections.some(s => !['overview', 'architecture', 'files', 'symbols', 'api', 'snapshots'].includes(s)))) return err('Invalid export sections');
  try {
    ctx.signal?.throwIfAborted();
    assertMutationFence(ctx.mutationFence, { kind: 'control', resource: 'mcp__export_docs', operation: 'export/publish' });
  } catch (error) { return err(`Document export rejected before dispatch: ${error instanceof Error ? error.message : error}`); }
  try {
    return ok(await ctx.ports.documentExport.invoke({ input: ctx.currentToolInvocation?.input ?? args,
      toolUseId: ctx.currentToolUseId, binding: ctx.mutationFence?.resourceBinding, signal: ctx.signal }));
  } catch { return unknownToolOutcome('Document export lost confirmation. Reconcile the original export before authorizing another write.'); }
}
