import type { ToolContext } from '@mcp/code-agent/core/tool.js';
import type { ToolRegistry } from '@mcp/code-agent/core/registry.js';
import type { ReviewReferenceHit, ReviewReferenceLookup } from '@mcp/services/services/review-absences.js';

const LOOKUP_TIMEOUT_MS = 5_000;

function parseHits(content: string): ReviewReferenceHit[] {
  if (content.length > 1_000_000) return [];
  const parsed = JSON.parse(content) as { references?: Array<{ file_path?: unknown; line?: unknown; context?: unknown }> };
  if (!Array.isArray(parsed.references)) return [];
  const hits: ReviewReferenceHit[] = [];
  for (const ref of parsed.references.slice(0, 200)) {
    if (typeof ref?.file_path !== 'string' || !ref.file_path) continue;
    hits.push({ filePath: ref.file_path,
      line: typeof ref.line === 'number' && Number.isFinite(ref.line) ? ref.line : null,
      context: typeof ref.context === 'string' ? ref.context : null });
  }
  return hits;
}

/** Cancel the owned lookup on its budget, and await its actual settlement.
 * A Promise.race timeout alone would abandon a still-running registry call. */
export function buildRegistryReferenceLookup(registry: ToolRegistry, ctx: ToolContext): ReviewReferenceLookup {
  return {
    async findReferences(symbolName: string): Promise<ReviewReferenceHit[]> {
      ctx.signal?.throwIfAborted();
      const controller = new AbortController();
      const signal = ctx.signal ? AbortSignal.any([ctx.signal, controller.signal]) : controller.signal;
      const timer = setTimeout(() => controller.abort(new Error('Review reference lookup timed out')), LOOKUP_TIMEOUT_MS);
      timer.unref();
      try {
        const args = { project_name: ctx.projectName, symbol_name: symbolName, format: 'json' };
        const result = await registry.invoke('mcp__find_references', args, { ...ctx, signal });
        ctx.signal?.throwIfAborted();
        if (!result || signal.aborted || result.isError) return [];
        return parseHits(result.content);
      } catch (error) {
        ctx.signal?.throwIfAborted();
        return [];
      } finally { clearTimeout(timer); }
    },
  };
}
