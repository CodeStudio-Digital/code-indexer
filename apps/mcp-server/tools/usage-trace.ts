import { defineTool, mcpAccess, normalizeMcpToolResult, type McpSourceTruncation } from '../tool.js';
import { withProject } from './_helpers.js';
import { findReferences } from './symbol-references.js';
import { currentSymbolBody } from './symbol-body-read.js';
import type { UsageTraceNode } from '@mcp/store/db/bounded-usage-trace.js';

export const traceUsage = defineTool({
  name: 'trace_usage', tier: 'navigate', ...mcpAccess('read'),
  description: 'Trace a bounded name-based usage graph through the declaration containing each call, including calls in the definition file. Depth 1..5 (default 3), five callers per branch, at most 100 call-site nodes and a 100 ms traversal budget. Every omitted branch has a recovery query. Unindexed projects use cancellable disk lexical hits at depth 1. This is not compiler-resolved call analysis.',
  inputSchema: { type: 'object', properties: { project_name: { type: 'string' }, symbol_name: { type: 'string' },
    depth: { type: 'integer', minimum: 1, maximum: 5 }, format: { type: 'string', enum: ['text', 'json'] },
    force_reread: { type: 'boolean' }, search_path: { type: 'string' },
  }, required: ['project_name', 'symbol_name'] },
  handler: withProject(async (args, ctx, project) => {
    const { db, signal } = ctx; signal?.throwIfAborted();
    if (project.is_synthetic) throw new Error('Synthetic projects are unsupported after the filesystem-session cutover');
    const name = args.symbol_name, depth = args.depth ?? 3;
    if (typeof name !== 'string' || !name.trim() || name.length > 1024) throw new Error('Invalid symbol name');
    if (typeof depth !== 'number' || !Number.isSafeInteger(depth) || depth < 1 || depth > 5) throw new Error('Usage depth must be an integer from 1 to 5');
    const tree = db.traceSymbolUsage(project.id, name, depth); signal?.throwIfAborted();
    if (!tree.defined_in && !tree.callers.length && !tree.truncations.length) {
      const result = normalizeMcpToolResult(await findReferences.handler({ project_name: project.name, symbol_name: name,
        source: 'disk', search_path: args.search_path, limit: 20, format: 'json' }, ctx));
      const data = JSON.parse(result.text) as { references: Array<{ file_path: string; line: number; context: string }>; recovery?: unknown; warnings?: string[] };
      let definition: { file: string; line: number } | undefined;
      for (const path of [...new Set(data.references.map(r => r.file_path))].slice(0, 5)) {
        signal?.throwIfAborted();
        try { const body = await currentSymbolBody(project.root_path, path, name, undefined, signal);
          if (!body.ambiguous) { definition = { file: path, line: body.start }; break; }
        } catch { signal?.throwIfAborted(); }
      }
      const callers = data.references.filter(r => !(r.file_path === definition?.file && r.line === definition.line));
      const note = `requested depth=${depth} but disk fallback only supports depth=1 — re-index the project for caller-graph traversal. Lexical hits may include imports/comments.`;
      const text = args.format === 'json' ? JSON.stringify({ symbol: name, source: 'disk_grep_fallback', definition,
        callers, depth: 1, note, recovery: data.recovery, warnings: data.warnings })
        : [`# Usage Tree: \`${name}\``, definition ? `Defined in: ${definition.file}:${definition.line} [tree-sitter fallback]`
          : 'Definition not found in the bounded disk scan', '## Callers (depth: 1, disk-grep fallback)',
        ...callers.map(r => `- **${r.file_path}**:${r.line}: ${r.context}`), ...(data.warnings ?? []), note,
        ...(data.recovery ? ['Continue: ' + JSON.stringify(data.recovery)] : [])].join('\n');
      return result.sourceTruncations?.length ? { text, sourceTruncations: result.sourceTruncations } : text;
    }
    const recoveries = tree.truncations.map(t => ({ ...t, recovery: { tool: 'find_references', project_name: project.name,
      symbol_name: t.symbol, offset: t.shown, source: 'index', reference_kind: t.reason === 'unclassified_references' ? 'unknown' : 'call' } }));
    const render = (nodes: UsageTraceNode[], indent = ''): string[] => nodes.flatMap(n => [
      `${indent}- **${n.file}**${n.line ? ':' + n.line : ''}${n.symbols_in_file.length ? ' in ' + n.symbols_in_file.join(', ') : ''}${n.stop ? ' [' + n.stop + ']' : ''}`,
      ...render(n.callers, indent + '  '),
    ]);
    const text = args.format === 'json' ? JSON.stringify({ ...tree, recoveries }) : [
      `# Usage Tree: \`${name}\``, tree.defined_in ? 'Defined in: ' + tree.defined_in : 'Definition not found in index',
      ...(tree.definition_count > 1 ? [`Name matches ${tree.definition_count} indexed definitions; the graph combines name-based occurrences.`] : []),
      `## Callers (depth: ${depth}; bounded name-based graph)`, ...render(tree.callers),
      ...recoveries.map(r => `Omitted ${r.total - r.shown} occurrences of ${r.symbol} (${r.reason}). Continue: ${JSON.stringify(r.recovery)}`),
    ].join('\n');
    const sourceTruncations: McpSourceTruncation[] = tree.truncations.length ? [{ technique: 'mcp-trace-usage-per-node-cap',
      inputSize: tree.truncations.reduce((sum, t) => sum + t.total, 0), outputSize: tree.truncations.reduce((sum, t) => sum + t.shown, 0),
      unit: 'items', recoverable: true }] : [];
    signal?.throwIfAborted();
    return sourceTruncations.length ? { text, sourceTruncations } : text;
  }),
});
