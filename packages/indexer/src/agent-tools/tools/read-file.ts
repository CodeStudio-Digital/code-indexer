import { defineTool, type McpToolResult } from '../tool.js';
import { withProject } from './_helpers.js';
import { projectRelativePath } from './project-read-path.js';
import { readProjectFile } from './project-file-read.js';
import { boundedTextOperation, scanPattern } from './bounded-pattern.js';
import { extractSymbolBodyFromContent, findSymbolDeclLineFromContent, findEnclosingDeclLine } from '@mcp/services/services/code-reader.js';

function positive(value: unknown, fallback: number, name: string): number {
  const result = value ?? fallback;
  if (typeof result !== 'number' || !Number.isSafeInteger(result) || result < 1) throw new Error(`${name} must be a positive integer`);
  return result;
}
function windowResult(text: string, total: number, retained: number): McpToolResult {
  return retained < total ? { text, sourceTruncations: [{ technique: 'mcp-read-file-line-window',
    inputSize: total, outputSize: retained, unit: 'lines', recoverable: true }] } : text;
}

export const readFile = defineTool({
  name: 'read_file', tier: 'navigate', access: 'read',
  description: 'Read current file contents within the project. Files up to 800 lines are returned in full unless a range or search is requested. Use symbol/around_line for a declaration, search_term for the first regex match, or force=true for all text (up to 16 MiB). Larger files support byte_offset/max_bytes pages, with UTF-8 boundaries preserved; encoding=base64 preserves arbitrary bytes. Follow recovery offsets for omitted content.',
  inputSchema: { type: 'object', properties: {
    project_name: { type: 'string' }, file_path: { type: 'string' }, symbol: { type: 'string' },
    around_line: { type: 'integer', minimum: 1 }, search_term: { type: 'string' },
    start_line: { type: 'integer', minimum: 1 }, end_line: { type: 'integer', minimum: 1 },
    max_lines: { type: 'integer', minimum: 1, description: 'Default 400.' }, force: { type: 'boolean' }, force_reread: { type: 'boolean' },
    byte_offset: { type: 'integer', minimum: 0 }, max_bytes: { type: 'integer', minimum: 4, maximum: 1048576 },
    encoding: { type: 'string', enum: ['utf8', 'base64'] },
  }, required: ['project_name', 'file_path'] },
  handler: withProject(async (args, { db, signal }, project) => {
    signal?.throwIfAborted();
    if (project.is_synthetic) throw new Error('Synthetic projects are unsupported after the filesystem-session cutover');
    const path = projectRelativePath(project.root_path, args.file_path);
    const startLine = positive(args.start_line, 1, 'start_line'), maxLines = positive(args.max_lines, 400, 'max_lines');
    const endLine = args.end_line == null ? undefined : positive(args.end_line, 1, 'end_line');
    if (endLine != null && endLine < startLine) throw new Error('end_line must be >= start_line');
    const around = args.around_line == null ? undefined : positive(args.around_line, 1, 'around_line');
    if (args.symbol != null && (typeof args.symbol !== 'string' || args.symbol.length > 1024)) throw new Error('Invalid symbol');
    if (args.search_term != null && typeof args.search_term !== 'string') throw new Error('search_term must be a regex string');
    if (args.force != null && typeof args.force !== 'boolean') throw new Error('force must be boolean');
    const byteMode = args.byte_offset != null || args.max_bytes != null || args.encoding != null;
    const byteOffset = args.byte_offset ?? 0, maxBytes = args.max_bytes ?? 65536, encoding = args.encoding ?? 'utf8';
    if (byteMode && (typeof byteOffset !== 'number' || !Number.isSafeInteger(byteOffset) || byteOffset < 0
      || typeof maxBytes !== 'number' || !Number.isSafeInteger(maxBytes) || maxBytes < 4 || maxBytes > 1048576
      || !['utf8', 'base64'].includes(encoding as string))) throw new Error('Invalid byte page');
    if (byteMode && [args.symbol, args.around_line, args.search_term, args.start_line, args.end_line, args.max_lines, args.force].some(v => v != null)) {
      throw new Error('Byte pages cannot be combined with text/symbol selectors');
    }
    let read;
    try { read = await readProjectFile(project.root_path, path, signal, byteMode
      ? { offset: byteOffset as number, limit: maxBytes as number, encoding: encoding as 'utf8' | 'base64' } : undefined); }
    catch (error) {
      signal?.throwIfAborted();
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error(`File "${path}" not found in index nor on disk`);
      throw error;
    }
    if (byteMode) {
      const omitted = read.retainedBytes < read.totalBytes;
      const text = JSON.stringify({ file: path, encoding, byte_offset: read.offset, total_bytes: read.totalBytes,
        retained_bytes: read.retainedBytes, next_byte_offset: read.nextByteOffset, content: read.content,
        ...(omitted ? { recovery: { tool: 'read_file', project_name: project.name, file_path: path,
          byte_offset: read.nextByteOffset ?? 0, max_bytes: maxBytes, encoding } } : {}) });
      return omitted ? { text, sourceTruncations: [{ technique: 'mcp-read-file-byte-page', inputSize: read.totalBytes,
        outputSize: read.retainedBytes, unit: 'bytes' as const, recoverable: true }] } : text;
    }
    const content = read.content, lines = content.split('\n'), total = lines.length;
    const symbol = typeof args.symbol === 'string' ? args.symbol.trim() : '';
    if (symbol || around != null) {
      const anchor = boundedTextOperation(() => symbol ? findSymbolDeclLineFromContent(content, symbol) : findEnclosingDeclLine(content, around!), signal);
      if (anchor == null) throw new Error(`Symbol '${symbol}' not found in ${path}. Use a line range or search_term.`);
      const body = boundedTextOperation(() => extractSymbolBodyFromContent(path, content, anchor), signal);
      signal?.throwIfAborted();
      return `${path} — symbol body (lines ${body.start_line}-${body.end_line} of ${total})\n${body.body}`
        + `\n[For surrounding content: read_file file_path=${JSON.stringify(path)}, start_line=${body.end_line + 1}]`;
    }
    const term = typeof args.search_term === 'string' ? args.search_term : '';
    const autoFull = !term && args.start_line == null && args.end_line == null && total <= 800;
    let start = startLine, note = '';
    if (term) {
      const index = scanPattern(term, lines, 'first', signal);
      if (index < 0) return `[Search term "${term}" not found in ${path}. Use grep_code to search across files.]`;
      start = Math.max(1, index + 1 - Math.floor(maxLines / 2));
      note = `[Auto-scrolled to line ${index + 1} matching "${term}"]\n`;
    }
    const end = Math.min(total, endLine ?? (args.force || autoFull ? total : start + maxLines - 1));
    const slice = lines.slice(start - 1, Math.max(start - 1, end));
    const indexed = db.getFile(project.id, path), disk = indexed ? '' : ' | [disk fallback — file not indexed]';
    const tag = autoFull ? ' [auto-full: file ≤800 lines]' : '';
    const header = `${path} | ${total} lines | ${path.split('.').pop() ?? ''}${disk}\n[lines ${start}-${end}]${tag}\n`;
    const footer = slice.length < total ? '\nContinue: ' + JSON.stringify({ tool: 'read_file', project_name: project.name,
      file_path: path, start_line: end < total ? end + 1 : 1, max_lines: maxLines }) : '';
    signal?.throwIfAborted();
    return windowResult(header + note + slice.map((line, i) => `${start + i}\t${line}`).join('\n') + footer, total, slice.length);
  }),
});
