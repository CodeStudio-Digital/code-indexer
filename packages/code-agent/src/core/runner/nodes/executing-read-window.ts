import type { CoderTool } from '../../tool.js';
import { isExplicitlyParallelSafeRead, resolveToolMetadata } from '../../policy.js';
import { invocationGuardKey, normalizeGuardInput } from '../guards/tuple-hash-dedup.js';

interface Call { id: string; name: string; input: Record<string, unknown> }

/** A dependency barrier ends the window. Equal normalized reads also form a
 * barrier so existing same-batch reuse observes the first completed result. */
export function independentReadWindow(calls: readonly Call[], lookup: (name: string) => CoderTool | null,
  retrieval: ReadonlyMap<string, { action: string; input?: Record<string, unknown> }>, visible?: ReadonlySet<string>): number {
  const keys = new Set<string>();
  let count = 0;
  for (const call of calls.slice(0, 4)) {
    const tool = lookup(call.name);
    const decision = retrieval.get(call.id);
    if (!tool || !isExplicitlyParallelSafeRead(tool) || resolveToolMetadata(tool).repeatPolicy !== 'stable'
      || decision?.action === 'coalesce' || (visible && !visible.has(call.name))) break;
    const key = invocationGuardKey(call.name, normalizeGuardInput(tool, decision?.input ?? call.input));
    if (keys.has(key)) break;
    keys.add(key); count++;
  }
  return Math.max(1, count);
}
