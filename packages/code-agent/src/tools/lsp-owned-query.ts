import type { ToolContext, ToolResult } from '../core/tool.js';
import { err } from '../core/tool.js';
import { resolveWorkspacePath } from './paths.js';
import { docPageArgs } from './doc-page.js';
import { defaultLocalFilesystemPort } from '../ports/filesystem-port.js';
import type { AgentLspQuery } from '../ports/lsp-port.js';

export async function ownedLspQuery(op: AgentLspQuery['op'], args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  try {
    ctx.signal?.throwIfAborted();
    const file = String(args.file_path ?? '').trim();
    if (!file) return err('file_path cannot be empty');
    const line = Number(args.line), column = Number(args.column);
    if (op !== 'diagnostics' && (!Number.isSafeInteger(line) || line < 1 || !Number.isSafeInteger(column) || column < 1)) return err('line and column must be positive integers (1-based)');
    const resolved = resolveWorkspacePath(file, ctx, 'read');
    if (!resolved.ok || resolved.external) return err(resolved.ok ? 'LSP requires an indexed project file' : resolved.reason);
    const fs = ctx.ports?.fs ?? defaultLocalFilesystemPort();
    if (!(await fs.stat(resolved.abs)).isFile()) return err('LSP requires a regular file');
    const page = docPageArgs(args, 200, 500); if ('error' in page) return page.error;
    const result = await ctx.ports!.lsp!.query({ op, root: resolved.rootPath, projectName: resolved.projectName,
      file: resolved.relativePath, line, column, ...page }, ctx.signal);
    ctx.signal?.throwIfAborted();
    if (result.kind === 'hover') {
      if (!result.hover) return { content: `No symbol info at ${file}:${line}:${column}` };
      return { content: [`kind: ${result.hover.kind}`, result.hover.displayString, result.hover.documentation].filter(Boolean).join('\n\n') };
    }
    if (result.offset > result.total) return err(`offset exceeds the current result count (${result.total}); repeat from offset 0 after edits`);
    const rows = result.kind === 'locations'
      ? result.items.map(item => `  ${item.file}:${item.line}:${item.column}${item.isWriteAccess ? '  [write]' : ''}`)
      : result.items.map(item => `${item.file}:${item.line}:${item.column} [${item.severity}] TS${item.code}: ${item.message}`);
    const content = result.total === 0 ? `No ${op} results for ${file}.`
      : [`Found ${result.total} ${op} result(s); showing ${result.offset + 1}–${result.offset + rows.length}:`, ...rows,
        ...(result.nextOffset != null ? ['Continue: lsp_' + op + '(' + JSON.stringify({ ...args, offset: result.nextOffset, limit: page.limit }) + ').'] : [])].join('\n');
    return { content, ...(result.nextOffset != null || result.offset > 0 ? { sourceTruncations: [{ technique: 'lsp-result-page',
      inputSize: result.total, outputSize: rows.length, unit: 'items' as const, recoverable: true }] } : {}) };
  } catch (cause) { return err(`lsp_${op} failed: ${cause instanceof Error ? cause.message : String(cause)}`); }
}
