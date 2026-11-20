import { defineTool, type McpToolResult } from '../tool.js';
import { withProject } from './_helpers.js';
import { projectRelativePath } from './project-read-path.js';
import { currentSymbolBody, locateCurrentSymbol } from './symbol-body-read.js';

function integer(value: unknown, fallback: number, min: number, max = Number.MAX_SAFE_INTEGER) {
  const n = value ?? fallback;
  if (typeof n !== 'number' || !Number.isSafeInteger(n) || n < min || n > max) throw new Error('Invalid symbol page or declaration line');
  return n;
}
function candidates(args: Record<string, unknown>, items: unknown[], total: number, offset: number): McpToolResult {
  const next = offset + items.length < total ? offset + items.length : undefined;
  const recovery = total > items.length ? { ...args, tool: 'get_symbol_body', candidate_offset: next ?? 0 } : undefined;
  const text = args.format === 'json'
    ? JSON.stringify({ error: 'ambiguous', symbol_name: args.symbol_name, total, candidates: items, next_candidate_offset: next, recovery })
    : `Ambiguous symbol '${args.symbol_name}'. Pass file_path and, for duplicate declarations in one file, declaration_line.\n`
      + JSON.stringify(items) + (recovery ? '\nContinue: ' + JSON.stringify(recovery) : '');
  return total > items.length ? { text, sourceTruncations: [{ technique: 'mcp-symbol-body-ambiguity-candidate-cap',
    inputSize: total, outputSize: items.length, unit: 'items', recoverable: true }] } : text;
}

export const getSymbolBody = defineTool({
  name: 'get_symbol_body', tier: 'navigate', access: 'read',
  description: 'Read a symbol from current file bytes. Indexed line numbers are revalidated; file_path never falls back to another file. Ambiguous definitions require file_path/declaration_line. Returns up to 500 lines with line_offset recovery. Current files up to 1 MiB use a bounded parser; larger/unsupported files use a labelled heuristic. New declarations absent from the index can be located in bounded file pages via file_scan_offset. Use read_file byte pages beyond 16 MiB.',
  inputSchema: { type: 'object', properties: {
    project_name: { type: 'string' }, symbol_name: { type: 'string' }, file_path: { type: 'string' },
    declaration_line: { type: 'integer', minimum: 1 }, line_offset: { type: 'integer', minimum: 0 },
    max_lines: { type: 'integer', minimum: 1, maximum: 500 }, candidate_offset: { type: 'integer', minimum: 0 },
    file_scan_offset: { type: 'integer', minimum: 0 }, format: { type: 'string', enum: ['text', 'json'] }, force_reread: { type: 'boolean' },
  }, required: ['project_name', 'symbol_name'] },
  handler: withProject(async (args, { db, signal }, project): Promise<McpToolResult> => {
    signal?.throwIfAborted();
    if (project.is_synthetic) throw new Error('Synthetic projects are unsupported after the filesystem-session cutover');
    const name = args.symbol_name;
    if (typeof name !== 'string' || !name.trim() || name.length > 1024 || name.includes('\0')) throw new Error('Invalid symbol name');
    let path = args.file_path == null ? undefined : projectRelativePath(project.root_path, args.file_path);
    const offset = integer(args.line_offset, 0, 0), maxLines = integer(args.max_lines, 500, 1, 500);
    const candidateOffset = integer(args.candidate_offset, 0, 0), scanOffset = integer(args.file_scan_offset, 0, 0);
    const declarationLine = args.declaration_line == null ? undefined : integer(args.declaration_line, 1, 1);
    if (declarationLine != null && !path) throw new Error('declaration_line requires file_path');
    const recoveryArgs = { project_name: project.name, symbol_name: name, ...(path ? { file_path: path } : {}), format: args.format };
    const definitions = db.listAgentSymbolDefinitions(project.id, name, path, { offset: 0, limit: 10 });
    if (!path && definitions.total > 1) {
      const page = candidateOffset ? db.listAgentSymbolDefinitions(project.id, name, undefined, { offset: candidateOffset, limit: 10 }) : definitions;
      return candidates(recoveryArgs, page.items, page.total, candidateOffset);
    }
    const indexed = definitions.items.find(s => declarationLine == null || s.line === declarationLine);
    path ??= indexed?.file_path;
    if (!path) {
      const scan = await locateCurrentSymbol(db, project.id, project.root_path, name, scanOffset, signal);
      path = scan.path;
      if (!path) {
        const recovery = scan.nextOffset == null ? { tool: 'search', query: name } : { ...recoveryArgs, tool: 'get_symbol_body', file_scan_offset: scan.nextOffset };
        throw new Error(`[SYMBOL_NOT_FOUND] Symbol "${name}" not found in ${scan.inspected} inspected files; ${scan.skipped} skipped/unreadable files, ${scan.total} indexed files total. This is not proof of absence. Pass file_path or continue: ${JSON.stringify(recovery)}. Do not retry with the same arguments.`);
      }
    }
    let body;
    try { body = await currentSymbolBody(project.root_path, path, name, declarationLine, signal); }
    catch (error) {
      signal?.throwIfAborted();
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes('[SYMBOL_NOT_FOUND]')) throw error;
      throw new Error(`[SYMBOL_READ_FAILED] Failed to read body for "${name}": ${message}`);
    }
    if (body.ambiguous) return candidates({ ...recoveryArgs, file_path: path }, body.candidates.slice(candidateOffset, candidateOffset + 10), body.candidates.length, candidateOffset);
    const start = body.start + offset, end = Math.min(body.end, start + maxLines - 1);
    const retained = body.lines.slice(start - 1, Math.max(start - 1, end));
    const total = body.end - body.start + 1, omitted = retained.length < total;
    const heuristic = body.rangeKind === 'heuristic';
    const next = end < body.end ? offset + retained.length : undefined;
    const recovery = heuristic && next == null
      ? { tool: 'read_file', project_name: project.name, file_path: path, start_line: end + 1, max_lines: maxLines }
      : omitted ? { ...recoveryArgs, tool: 'get_symbol_body', file_path: path, declaration_line: declarationLine,
        line_offset: next ?? 0, max_lines: maxLines } : undefined;
    const textBody = retained.map((line, i) => `${start + i}\t${line}`).join('\n');
    const note = heuristic ? 'Heuristic range; completeness is not guaranteed. Read surrounding lines to verify.' : undefined;
    const value = { symbol_name: name, file_path: path, declaration_line: body.start, start_line: start, end_line: retained.length ? end : start - 1,
      body: textBody, stable_id: indexed?.stable_id ?? null, used_fallback: !indexed || indexed.line !== body.start,
      range_kind: body.rangeKind, note, ...(!heuristic ? { total_lines: total } : {}),
      line_offset: offset, next_line_offset: next, truncated: omitted || heuristic, recovery };
    signal?.throwIfAborted();
    const text = args.format === 'json' ? JSON.stringify(value) : `${path}:${value.start_line}-${value.end_line} [${body.rangeKind}]\n\n${textBody}`
      + (value.note ? '\n' + value.note : '') + (recovery ? '\nContinue: ' + JSON.stringify(recovery) : '');
    return omitted || heuristic ? { text, sourceTruncations: [{ technique: 'mcp-symbol-body-line-page',
      inputSize: heuristic ? body.lines.length - body.start + 1 : total, inputSizeExact: !heuristic,
      outputSize: retained.length, unit: 'lines', recoverable: true }] } : text;
  }),
});
