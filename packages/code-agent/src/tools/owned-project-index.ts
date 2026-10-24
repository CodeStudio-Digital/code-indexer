import { assertMutationFence } from '../core/mutation-fence.js';
import { realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import { err, ok, unknownToolOutcome, type ToolContext, type ToolResult } from '../core/tool.js';

export async function invokeOwnedProjectIndex(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  if (!ctx.ports?.projectIndex) return err('Indexing requires the current application owner.');
  if (typeof input.project_path !== 'string' || !input.project_path.trim() || input.project_path.length > 32768
    || input.project_path.includes('\0') || (input.rebuild_semantic != null && typeof input.rebuild_semantic !== 'boolean')) {
    return err('Invalid project indexing arguments');
  }
  try {
    ctx.signal?.throwIfAborted();
    const paths = await Promise.all([realpath(ctx.cwd), realpath(resolve(ctx.cwd, input.project_path))]);
    const roots = paths.map(path => process.platform === 'win32' ? path.toLowerCase() : path);
    if (roots[0] !== roots[1]) return err('Indexing path is outside the current project root.');
    ctx.signal?.throwIfAborted();
    assertMutationFence(ctx.mutationFence, { kind: 'control', resource: 'mcp__index_project', operation: 'index/reconcile' });
  } catch (error) { return err(`Indexing rejected before dispatch: ${error instanceof Error ? error.message : error}`); }
  try {
    return ok(await ctx.ports.projectIndex.invoke({ input: ctx.currentToolInvocation?.input ?? input,
      toolUseId: ctx.currentToolUseId, binding: ctx.mutationFence?.resourceBinding, signal: ctx.signal }));
  } catch {
    return unknownToolOutcome('Indexing lost confirmation. Inspect the project index and its jobs before authorizing another mutation.');
  }
}
