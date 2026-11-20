import { defineTool, normalizeMcpToolResult, type McpSourceTruncation } from '../tool.js';
import { withProject } from './_helpers.js';
import { editBody, addEditCap } from './prepare-edit-body.js';
import { findReferences } from './symbol-references.js';
import { readProjectFile } from './project-file-read.js';
import { treeSitterSymbols } from '@mcp/indexer/indexer/incremental.js';

function integer(value: unknown, fallback: number, min: number, max = Number.MAX_SAFE_INTEGER) {
  const n = value ?? fallback;
  if (typeof n !== 'number' || !Number.isSafeInteger(n) || n < min || n > max) throw new Error('Invalid prepare_edit page');
  return n;
}
export const prepareEdit = defineTool({
  name: 'prepare_edit', tier: 'navigate', access: 'read',
  description: 'Fetch the current symbol body, a page of indexed name-based callers ordered by proximity, nearby declarations, imports and covering test files. Explicit file_path never changes scope. Counts and recovery offsets describe omitted callers/imports/tests; missing ranges or incomplete disk scans are labelled. Default 10 callers (max 50), 50 imports (max 100), five tests (max 50). Unindexed projects use a bounded disk fallback; imports/tests require the index. Use file_path/declaration_line for ambiguous symbols.',
  inputSchema: { type: 'object', properties: {
    project_name: { type: 'string' }, symbol_name: { type: 'string' }, file_path: { type: 'string' }, search_path: { type: 'string' },
    declaration_line: { type: 'integer', minimum: 1 }, candidate_offset: { type: 'integer', minimum: 0 },
    max_callers: { type: 'integer', minimum: 1, maximum: 50 }, callers_offset: { type: 'integer', minimum: 0 },
    max_imports: { type: 'integer', minimum: 1, maximum: 100 }, imports_offset: { type: 'integer', minimum: 0 },
    max_tests: { type: 'integer', minimum: 1, maximum: 50 }, tests_offset: { type: 'integer', minimum: 0 },
    max_lines: { type: 'integer', minimum: 1, maximum: 500 }, line_offset: { type: 'integer', minimum: 0 },
    format: { type: 'string', enum: ['text', 'json'] }, force_reread: { type: 'boolean' },
  }, required: ['project_name', 'symbol_name'] },
  handler: withProject(async (args, ctx, project) => {
    const { db, signal } = ctx; signal?.throwIfAborted();
    const maxCallers = integer(args.max_callers, 10, 1, 50), callersOffset = integer(args.callers_offset, 0, 0);
    const importsLimit = integer(args.max_imports, 50, 1, 100), importsOffset = integer(args.imports_offset, 0, 0);
    const testsLimit = integer(args.max_tests, 5, 1, 50), testsOffset = integer(args.tests_offset, 0, 0);
    const loaded = await editBody({ ...args, project_name: project.name }, ctx), body = loaded.body;
    const caps: McpSourceTruncation[] = [...loaded.sourceTruncations];
    if (body.error === 'ambiguous') {
      const text = JSON.stringify(body);
      return caps.length ? { text, sourceTruncations: caps.map(cap => ({ ...cap, technique: 'mcp-prepare-edit-ambiguity-candidate-cap' })) } : text;
    }
    const path = body.file_path, name = args.symbol_name as string, anchor = body.declaration_line ?? body.start_line;
    const indexed = db.listAgentSymbolDefinitions(project.id, name, path, { offset: 0, limit: 10 }).items;
    const symbol = indexed.find(s => s.line === anchor) ?? (indexed.length === 1 ? indexed[0] : undefined);
    const context = db.getAgentEditContext(project.id, path, anchor, { importsOffset, importsLimit, testsOffset, testsLimit });
    const references = db.listAgentSymbolReferences(project.id, name, { limit: maxCallers, offset: callersOffset, targetFile: path });
    let callers: { total?: number; total_at_least?: number; total_exact: boolean; shown: number; truncated: boolean; items: unknown[]; recovery?: unknown };
    const base = { tool: 'prepare_edit', project_name: project.name, symbol_name: name, file_path: path, declaration_line: anchor, format: args.format };
    const notes = ['Callers are indexed/lexical occurrences by name, not compiler-resolved references. Neighbor/import/test metadata may lag the current body.'];
    if (references.total || callersOffset) {
      const shown = references.items.length;
      callers = { total: references.total, total_exact: true, shown, truncated: shown < references.total, items: references.items,
        ...(shown < references.total ? { recovery: { ...base, max_callers: maxCallers,
          callers_offset: callersOffset + shown < references.total ? callersOffset + shown : 0 } } : {}) };
      addEditCap(caps, 'mcp-prepare-edit-caller-cap', references.total, shown);
      const clipped = references.items.filter(r => r.context_truncated);
      if (clipped.length) caps.push({ technique: 'mcp-reference-context-cap', inputSize: clipped.reduce((s, r) => s + r.context_characters, 0),
        outputSize: clipped.reduce((s, r) => s + Array.from(r.context ?? '').length, 0), unit: 'chars', recoverable: true });
    } else {
      const result = normalizeMcpToolResult(await findReferences.handler({ project_name: project.name, symbol_name: name,
        source: 'disk', search_path: args.search_path, limit: maxCallers, format: 'json' }, ctx));
      const data = JSON.parse(result.text) as { total?: number; total_at_least?: number; total_exact: boolean; truncated: boolean; references: Array<{ file_path: string; line: number }>; recovery?: unknown; warnings?: string[] };
      const items = data.references.filter(r => !(r.file_path === path && r.line === anchor));
      const excluded = data.references.length - items.length;
      callers = { total: data.total == null ? undefined : Math.max(0, data.total - excluded), total_at_least: data.total_at_least == null ? undefined : Math.max(0, data.total_at_least - excluded),
        total_exact: data.total_exact, shown: items.length, truncated: data.truncated, items, recovery: data.recovery };
      caps.push(...(result.sourceTruncations ?? []));
      notes.push(...(data.warnings ?? []));
    }
    let neighbors = context.neighbors.map(s => ({ name: s.name, kind: s.kind, line: s.line, is_target: s.name === name && s.line === anchor }));
    if (!context.indexed) {
      notes.push('disk fallback: imports and covering tests require indexing.');
      try {
        const current = await readProjectFile(project.root_path, path, signal, { offset: 0, limit: 1024 * 1024 + 4, encoding: 'utf8' });
        if (current.totalBytes <= 1024 * 1024) {
          const parsed = await treeSitterSymbols(path, current.content, { signal });
          const symbols = parsed?.symbols ?? [], at = symbols.findIndex(s => s.name === name && s.line === anchor);
          neighbors = symbols.slice(Math.max(0, at - 3), Math.max(0, at - 3) + 7)
            .map(s => ({ name: s.name, kind: s.kind, line: s.line, is_target: s.name === name && s.line === anchor }));
        } else notes.push('Neighbor outline exceeds 1 MiB; use read_file pages.');
      } catch { signal?.throwIfAborted(); notes.push('Current neighbors could not be read; body remains from the earlier verified read.'); }
    }
    addEditCap(caps, 'mcp-prepare-edit-import-cap', context.imports.total, context.imports.items.length);
    addEditCap(caps, 'mcp-prepare-edit-test-cap', context.tests.total, context.tests.items.length);
    const importsRecovery = context.imports.items.length < context.imports.total ? { ...base, max_imports: importsLimit,
      imports_offset: importsOffset + context.imports.items.length < context.imports.total ? importsOffset + context.imports.items.length : 0 } : undefined;
    const testsRecovery = context.tests.items.length < context.tests.total ? { ...base, max_tests: testsLimit,
      tests_offset: testsOffset + context.tests.items.length < context.tests.total ? testsOffset + context.tests.items.length : 0 } : undefined;
    const value = { symbol: { name, kind: symbol?.kind ?? '?', signature: symbol?.signature ?? null, file_path: path, line: anchor, stable_id: body.stable_id ?? null },
      source: context.indexed ? 'index_with_current_body' : 'disk_fallback', body: { file: path, ...body }, callers, neighbors,
      imports: context.imports.items, imports_total: context.imports.total, imports_recovery: importsRecovery,
      tests_covering: context.tests.items, tests_covering_total: context.tests.total, tests_covering_truncated: context.tests.items.length < context.tests.total,
      tests_recovery: testsRecovery, notes };
    signal?.throwIfAborted();
    const text = args.format === 'json' ? JSON.stringify(value) : [`=== prepare_edit: ${name} ===`, `file: ${path}:${body.start_line}-${body.end_line}`,
      '[BODY]', body.body, ...(body.recovery ? ['Body continuation: ' + JSON.stringify(body.recovery)] : []),
      `[CALLERS] (${callers.total ?? 'at least ' + callers.total_at_least})`, JSON.stringify(callers.items),
      ...(callers.recovery ? ['Callers continuation: ' + JSON.stringify(callers.recovery)] : []),
      '[NEIGHBORS]', neighbors.map(s => `${s.line} ${s.kind} ${s.name}`).join('\n'), '[IMPORTS]', context.imports.items.join('\n') || 'none',
      ...(importsRecovery ? ['Imports continuation: ' + JSON.stringify(importsRecovery)] : []), '[TESTS COVERING]', context.tests.items.join('\n') || 'none',
      ...(testsRecovery ? ['Tests continuation: ' + JSON.stringify(testsRecovery)] : []), ...notes].join('\n');
    return caps.length ? { text, sourceTruncations: caps } : text;
  }),
});
