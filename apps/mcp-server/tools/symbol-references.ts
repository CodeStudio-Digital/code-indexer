import { defineTool, mcpAccess, type McpToolResult, type McpSourceTruncation } from '../tool.js';
import { withProject } from './_helpers.js';
import { projectRelativePath } from './project-read-path.js';
import { currentSymbolBody } from './symbol-body-read.js';
import { diskReferences } from './symbol-disk-search.js';

function integer(value: unknown, fallback: number, min: number, max = Number.MAX_SAFE_INTEGER) {
  const result = value ?? fallback;
  if (typeof result !== 'number' || !Number.isSafeInteger(result) || result < min || result > max) throw new Error('Invalid reference page');
  return result;
}
export const findReferences = defineTool({
  name: 'find_references', tier: 'navigate', ...mcpAccess('read'),
  description: 'Page through indexed occurrences of a symbol name (default 50, max 500). Definitions are listed for ambiguous names. file_path identifies the requested definition but incoming references remain name-based; use LSP for exact resolution. If the index has no references, scans current source files with explicit file/line cursors, time and byte budgets. Disk hits include declarations, comments and imports. Follow recovery, or narrow search_path; restart disk cursors after filesystem edits.',
  inputSchema: { type: 'object', properties: {
    project_name: { type: 'string' }, symbol_name: { type: 'string' }, file_path: { type: 'string' },
    limit: { type: 'integer', minimum: 1, maximum: 500 }, offset: { type: 'integer', minimum: 0 },
    candidate_offset: { type: 'integer', minimum: 0 }, source: { type: 'string', enum: ['auto', 'index', 'disk'] },
    reference_kind: { type: 'string', enum: ['all', 'call', 'import', 'unknown'], description: 'Index classification filter. Old unclassified rows remain unknown until reindexing. Disk fallback supports all only.' },
    search_path: { type: 'string' }, scan_file_offset: { type: 'integer', minimum: 0 }, scan_line_offset: { type: 'integer', minimum: 0 },
    format: { type: 'string', enum: ['text', 'json'] }, force_reread: { type: 'boolean' },
  }, required: ['project_name', 'symbol_name'] },
  handler: withProject(async (args, { db, signal }, project): Promise<McpToolResult> => {
    signal?.throwIfAborted();
    if (project.is_synthetic) throw new Error('Synthetic projects are unsupported after the filesystem-session cutover');
    const name = args.symbol_name;
    if (typeof name !== 'string' || !name.trim() || name.length > 1024 || name.includes('\0')) throw new Error('Invalid symbol name');
    const limit = integer(args.limit, 50, 1, 500), offset = integer(args.offset, 0, 0), candidateOffset = integer(args.candidate_offset, 0, 0);
    const fileOffset = integer(args.scan_file_offset, 0, 0), lineOffset = integer(args.scan_line_offset, 0, 0);
    const source = args.source ?? 'auto'; if (!['auto', 'index', 'disk'].includes(source as string)) throw new Error('Invalid reference source');
    const referenceKind = args.reference_kind ?? 'all';
    if (!['all', 'call', 'import', 'unknown'].includes(referenceKind as string)) throw new Error('Invalid reference kind');
    if (source === 'disk' && referenceKind !== 'all') throw new Error('Disk lexical references cannot classify call/import; use source=index or reference_kind=all');
    const file = args.file_path == null ? undefined : projectRelativePath(project.root_path, args.file_path);
    const searchPath = projectRelativePath(project.root_path, args.search_path ?? '');
    const definitions = db.listAgentSymbolDefinitions(project.id, name, file, { offset: candidateOffset, limit: 10 });
    if (file && !definitions.total) await currentSymbolBody(project.root_path, file, name, undefined, signal);
    const commonArgs = { project_name: project.name, symbol_name: name, ...(file ? { file_path: file } : {}), limit, format: args.format, reference_kind: referenceKind };
    const indexed = source === 'disk' ? null : db.listAgentSymbolReferences(project.id, name, { offset, limit, referenceKind: referenceKind as 'all' | 'call' | 'import' | 'unknown' });
    const truncations: McpSourceTruncation[] = [];
    const nextCandidate = candidateOffset + definitions.items.length < definitions.total ? candidateOffset + definitions.items.length : undefined;
    const ambiguous = definitions.total > 1;
    const candidateRecovery = definitions.total > definitions.items.length ? { ...commonArgs, tool: 'find_references', candidate_offset: nextCandidate ?? 0 } : undefined;
    if (candidateRecovery) truncations.push({ technique: 'mcp-symbol-ambiguity-candidate-cap', inputSize: definitions.total,
      outputSize: definitions.items.length, unit: 'items', recoverable: true });
    const note = 'References are indexed by name, not compiler-resolved; file_path verifies the definition only. Use LSP for exact references. Legacy classification is unknown until reindexing. Context snippets are limited to 1024 characters; use read_file at the reported line for complete text.';
    let value: Record<string, unknown>, lines: string[];
    if (indexed && (indexed.total > 0 || source === 'index' || referenceKind !== 'all')) {
      const next = offset + indexed.items.length < indexed.total ? offset + indexed.items.length : undefined;
      const omitted = indexed.total > indexed.items.length;
      const recovery = omitted ? { ...commonArgs, tool: 'find_references', source: 'index', offset: next ?? 0 } : undefined;
      value = { symbol_name: name, source: 'db', ambiguous, candidates: definitions.items, candidate_total: definitions.total,
        candidate_recovery: candidateRecovery, total: indexed.total, total_exact: true, references: indexed.items,
        offset, next_offset: next, truncated: omitted, recovery, reference_kind: referenceKind, note };
      lines = indexed.items.map(r => `${r.file_path}:${r.line ?? '?'}${r.context ? ': ' + r.context : ''}`);
      if (!lines.length) lines.push('No indexed references on this page.');
      if (recovery) lines.push('Continue: ' + JSON.stringify(recovery));
      if (omitted) truncations.push({ technique: 'mcp-find-references-index-page', inputSize: indexed.total,
        outputSize: indexed.items.length, unit: 'items', recoverable: true });
    } else {
      if (offset) throw new Error('Disk fallback uses scan_file_offset/scan_line_offset, not index offset; start at zero or use source=index');
      const disk = await diskReferences(project.root_path, name, searchPath, limit, { file_offset: fileOffset, line_offset: lineOffset }, signal);
      const exact = disk.complete && !fileOffset && !lineOffset;
      const recovery = disk.next ? { ...commonArgs, tool: 'find_references', source: 'disk', search_path: searchPath,
        scan_file_offset: disk.next.file_offset, scan_line_offset: disk.next.line_offset } : undefined;
      value = { symbol_name: name, source: 'disk_grep_fallback', ambiguous, candidates: definitions.items,
        candidate_total: definitions.total, candidate_recovery: candidateRecovery, total: exact ? disk.references.length : undefined,
        total_at_least: exact ? undefined : disk.observedMatches, total_exact: exact, truncated: !exact,
        references: disk.references, recovery, scanned_files: disk.scannedFiles, skipped_files: disk.skippedFiles, warnings: disk.warnings, note };
      lines = ['[disk-grep fallback — lexical occurrences; not compiler references]', ...disk.references.map(r => `${r.file_path}:${r.line}: ${r.context}`), ...disk.warnings];
      if (!disk.references.length) lines.push(exact ? 'No references found.' : 'No hits on this bounded page; absence is not proof. Narrow search_path or continue.');
      if (recovery) lines.push('Continue: ' + JSON.stringify(recovery));
      if (!exact) truncations.push({ technique: 'mcp-find-references-fallback-cap', inputSize: disk.observedMatches,
        inputSizeExact: false, outputSize: disk.references.length, unit: 'items', recoverable: true });
    }
    if (ambiguous) lines.unshift('Candidate definitions: ' + JSON.stringify(definitions.items));
    if (candidateRecovery) lines.push('Candidate page: ' + JSON.stringify(candidateRecovery));
    const clipped = (value.references as Array<{ context: string | null; context_truncated: boolean | number; context_characters: number }>).filter(r => r.context_truncated);
    if (clipped.length) truncations.push({ technique: 'mcp-reference-context-cap', inputSize: clipped.reduce((sum, r) => sum + r.context_characters, 0),
      outputSize: clipped.reduce((sum, r) => sum + Array.from(r.context ?? '').length, 0), unit: 'chars', recoverable: true });
    signal?.throwIfAborted();
    const text = args.format === 'json' ? JSON.stringify(value) : [...lines, note].join('\n');
    return truncations.length ? { text, sourceTruncations: truncations } : text;
  }),
});
