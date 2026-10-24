import type { DB } from './types.js';

export interface UsageTraceNode {
  file: string; line: number | null; symbols_in_file: string[]; callers: UsageTraceNode[];
  stop?: 'already_expanded' | 'depth_limit' | 'node_limit' | 'time_limit' | 'unresolved_caller';
}
export interface UsageTraceOmission { symbol: string; total: number; shown: number; reason: string }
export interface UsageTraceResult {
  symbol: string; defined_in: string | null; callers: UsageTraceNode[];
  truncations: UsageTraceOmission[]; visited_nodes: number; max_depth: number; graph_kind: 'name_based';
  definition_count: number;
}

/** Bound work before materialization, including the CLI caller. Caller symbols
 * come from the enclosing declaration, never every declaration in a hit file. */
export function traceUsage(db: DB, projectId: number, symbolName: string, maxDepth = 3): UsageTraceResult {
  if (!Number.isSafeInteger(maxDepth) || maxDepth < 1 || maxDepth > 5) throw new Error('Usage depth must be an integer from 1 to 5');
  if (!symbolName.trim() || symbolName.length > 1024) throw new Error('Invalid symbol name');
  return db.transaction(() => {
    const root = db.prepare('SELECT file_path FROM symbols WHERE project_id=? AND name=? ORDER BY file_path, line, id LIMIT 1')
      .get(projectId, symbolName) as { file_path: string } | undefined;
    const definitions = (db.prepare('SELECT COUNT(*) AS n FROM symbols WHERE project_id=? AND name=?').get(projectId, symbolName) as { n: number }).n;
    const count = db.prepare("SELECT COUNT(*) AS n FROM symbol_references WHERE project_id=? AND symbol_name=? AND reference_kind='call'");
    const unknown = db.prepare('SELECT COUNT(*) AS n FROM symbol_references WHERE project_id=? AND symbol_name=? AND reference_kind IS NULL');
    const page = db.prepare("SELECT referencing_file_id, referencing_file_path, line FROM symbol_references WHERE project_id=? AND symbol_name=? AND reference_kind='call' ORDER BY referencing_file_path,line,col,id LIMIT ?");
    const enclosing = db.prepare(`SELECT name FROM symbols WHERE project_id=? AND file_id=? AND line<=? AND end_line>=?
      AND kind IN ('function','method','class') ORDER BY line DESC, end_line, id LIMIT 1`);
    const expanded = new Map<string, number>(), truncations: UsageTraceOmission[] = [];
    const deadline = performance.now() + 100; let nodes = 0;
    function trace(name: string, depth: number): UsageTraceNode[] {
      const previousDepth = expanded.get(name);
      if (previousDepth != null && previousDepth <= depth) return [];
      const unclassified = (unknown.get(projectId, name) as { n: number }).n;
      if (unclassified) truncations.push({ symbol: name, total: unclassified, shown: 0, reason: 'unclassified_references' });
      const total = (count.get(projectId, name) as { n: number }).n;
      if (!total) return [];
      const remaining = Math.max(0, 100 - nodes), timedOut = performance.now() > deadline;
      if (depth >= maxDepth || !remaining || timedOut) {
        truncations.push({ symbol: name, total, shown: 0, reason: timedOut ? 'time_limit' : !remaining ? 'node_limit' : 'depth_limit' }); return [];
      }
      expanded.set(name, depth);
      const refs = page.all(projectId, name, Math.min(5, remaining)) as Array<{ referencing_file_id: number; referencing_file_path: string; line: number | null }>;
      const result: UsageTraceNode[] = [];
      for (const ref of refs) {
        if (nodes >= 100 || performance.now() > deadline) break;
        nodes++;
        const caller = ref.line == null ? undefined : enclosing.get(projectId, ref.referencing_file_id, ref.line, ref.line) as { name: string } | undefined;
        const previous = caller ? expanded.get(caller.name) : undefined;
        const repeated = previous != null && previous <= depth + 1;
        const children = caller && !repeated ? trace(caller.name, depth + 1) : [];
        const stop = caller ? repeated ? 'already_expanded' : depth + 1 >= maxDepth ? 'depth_limit'
          : nodes >= 100 ? 'node_limit' : performance.now() > deadline ? 'time_limit' : undefined : 'unresolved_caller';
        result.push({ file: ref.referencing_file_path, line: ref.line, symbols_in_file: caller ? [caller.name] : [], callers: children,
          ...(stop ? { stop } : {}) });
      }
      if (result.length < total) truncations.push({ symbol: name, total, shown: result.length,
        reason: nodes >= 100 ? 'node_limit' : performance.now() > deadline ? 'time_limit' : 'breadth_limit' });
      return result;
    }
    const callers = trace(symbolName, 0);
    return { symbol: symbolName, defined_in: root?.file_path ?? null, definition_count: definitions, callers, truncations, visited_nodes: nodes, max_depth: maxDepth, graph_kind: 'name_based' as const };
  })();
}
