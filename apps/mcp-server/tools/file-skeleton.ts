import { defineTool, mcpAccess, type McpToolResult } from '../tool.js';
import { withProject } from './_helpers.js';
import { projectRelativePath } from './project-read-path.js';
import { readProjectFile } from './project-file-read.js';
import { boundedTextOperation, scanPattern } from './bounded-pattern.js';
import { treeSitterSymbols } from '@mcp/indexer/indexer/incremental.js';
import { extractSkeletonFromContent } from '@mcp/services/services/code-reader.js';
import type { OutlineSymbol } from '@mcp/store/db/agent-symbol-reads.js';

export const fileSkeleton = defineTool({
  name: 'get_file_skeleton', tier: 'bootstrap', ...mcpAccess('read'),
  description: 'Page through a file outline or exported declarations in an indexed directory. Default 100 symbols, maximum 500. Follow offset for the tail. kind filters the query; filter is a bounded regex applied to each candidate page, so filtered totals are not global totals. Unindexed files up to 1 MiB use a bounded tree-sitter outline; larger files should be indexed or read in ranges.',
  inputSchema: { type: 'object', properties: {
    project_name: { type: 'string' }, file_path: { type: 'string' }, kind: { type: 'string' }, filter: { type: 'string' },
    max_symbols: { type: 'integer', minimum: 1, maximum: 500 }, offset: { type: 'integer', minimum: 0 },
    format: { type: 'string', enum: ['text', 'json'] }, force_reread: { type: 'boolean' },
  }, required: ['project_name', 'file_path'] },
  handler: withProject(async (args, { db, signal }, project): Promise<McpToolResult> => {
    signal?.throwIfAborted();
    if (project.is_synthetic) throw new Error('Synthetic projects are unsupported after the filesystem-session cutover');
    const path = projectRelativePath(project.root_path, args.file_path), requested = args.max_symbols ?? 100, offset = args.offset ?? 0;
    if (typeof requested !== 'number' || !Number.isSafeInteger(requested) || requested < 1
      || typeof offset !== 'number' || !Number.isSafeInteger(offset) || offset < 0) throw new Error('Invalid symbol page');
    const limit = Math.min(requested, 500);
    if (args.kind != null && (typeof args.kind !== 'string' || args.kind.length > 128)) throw new Error('Invalid symbol kind');
    if (args.filter != null && (typeof args.filter !== 'string' || args.filter.length > 1024)) throw new Error('Invalid symbol filter');
    const kind = args.kind as string | undefined, filter = args.filter as string | undefined;
    const input = { offset, limit, kind }, indexed = db.getAgentFileSkeleton(project.id, path, input);
    signal?.throwIfAborted();
    let symbols = indexed.symbols, total = indexed.total, next = indexed.nextOffset;
    let file = indexed.file, source = 'index', warning = '';
    const readOutline = async () => {
      const read = await readProjectFile(project.root_path, path, signal, { offset: 0, limit: 1024 * 1024 + 4, encoding: 'utf8' });
      if (read.totalBytes > 1024 * 1024) throw new Error('Interactive skeleton exceeds 1 MiB; index the file or read bounded ranges');
      return read;
    };
    if (!file && !indexed.files) {
      let read;
      try { read = await readOutline(); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error(`File "${path}" not found in index nor on disk`);
        throw error;
      }
      const parsed = await treeSitterSymbols(path, read.content, { signal });
      const fallback = parsed?.symbols ?? boundedTextOperation(() => extractSkeletonFromContent(read.content), signal);
      let all: OutlineSymbol[] = fallback.map(s => ({ ...s, file_path: path,
        parent: 'parent' in s && typeof s.parent === 'string' ? s.parent : null,
        stable_id: null, end_line: 'end_line' in s && typeof s.end_line === 'number' ? s.end_line : null }));
      if (kind) all = all.filter(s => s.kind === kind);
      total = all.length; symbols = all.slice(offset, offset + limit); next = offset + symbols.length < total ? offset + symbols.length : undefined;
      source = parsed ? 'tree-sitter-fallback' : 'regex-fallback';
      file = { path, language: path.split('.').pop() ?? '', line_count: read.content.split('\n').length,
        size: read.totalBytes, content_hash: '' };
    } else if (file && total < 3 && file.line_count > 80 && !kind && !filter) {
      // Preserve the legacy sparse-index supplement without re-reading the
      // file synchronously or running a complete import/call-graph extraction.
      try {
        const read = await readOutline();
        const base = offset ? db.getAgentFileSkeleton(project.id, path, { offset: 0, limit: 500 }).symbols : symbols;
        const known = new Set(base.map(s => `${s.line}:${s.name}`));
        const extras = boundedTextOperation(() => extractSkeletonFromContent(read.content), signal)
          .filter(s => !known.has(`${s.line}:${s.name}`)).map(s => ({ ...s, file_path: path, parent: null, end_line: null, stable_id: null }));
        const all = [...base, ...extras]; total = all.length; symbols = all.slice(offset, offset + limit);
        next = offset + symbols.length < total ? offset + symbols.length : undefined;
        if (extras.length) warning = 'regex fallback supplements sparse indexed symbols';
      } catch (error) {
        signal?.throwIfAborted(); warning = `Additional disk outline unavailable: ${error instanceof Error ? error.message : String(error)}`;
      }
    }
    const candidateCount = symbols.length;
    if (filter) symbols = scanPattern(filter, symbols.map(s => s.name), 'filter', signal).map(i => symbols[i]);
    signal?.throwIfAborted();
    const omitted = total > candidateCount;
    const recovery = omitted ? { tool: 'get_file_skeleton', project_name: project.name, file_path: path,
      ...(kind ? { kind } : {}), ...(filter ? { filter } : {}), offset: next ?? 0, max_symbols: limit } : undefined;
    const meta = { source, ...(filter ? { total_candidates: total, candidates_in_page: candidateCount, matched_symbols_in_page: symbols.length }
      : { total_symbols: total }), shown_symbols: symbols.length, offset, next_offset: next, truncated: omitted,
      ...(warning ? { warning } : {}), ...(recovery ? { recovery } : {}) };
    let text: string;
    if (args.format === 'json') {
      const grouped = new Map<string, OutlineSymbol[]>();
      for (const s of symbols) { const group = grouped.get(s.file_path) ?? []; group.push(s); grouped.set(s.file_path, group); }
      text = JSON.stringify(file ? { file: { path, ext: path.split('.').pop() ?? '', language: file.language,
        line_count: file.line_count, size_bytes: file.size, content_hash: file.content_hash }, ...meta, symbols }
        : { directory: path, files_in_dir: indexed.files, ...meta, files: [...grouped].map(([path, symbols]) => ({ path, symbols })) });
    } else {
      const header = file ? `${path} | ${file.language} | ${file.line_count}L | ${file.size} bytes | ${source.replace('-fallback', ' fallback')}`
        : `DIR ${path || '.'} | ${indexed.files} files | exported symbols`;
      text = [header, warning, ...symbols.map(s => `${file ? '' : s.file_path + ':'}${s.line ?? '?'} ${s.kind} ${s.parent ? s.parent + '.' : ''}${s.name} ${s.signature}`),
        ...(recovery ? ['Continue: ' + JSON.stringify(recovery)] : [])].filter(Boolean).join('\n');
    }
    return omitted ? { text, sourceTruncations: [{ technique: filter ? 'mcp-file-skeleton-candidate-page' : 'mcp-file-skeleton-symbol-cap',
      inputSize: total, outputSize: filter ? candidateCount : symbols.length, unit: 'items', recoverable: true }] } : text;
  }),
});
