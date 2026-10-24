import { normalizeMcpToolResult, type McpSourceTruncation } from '../tool.js';
import type { ToolContext } from '../context.js';
import { getSymbolBody } from './symbol-body.js';
import { findReferences } from './symbol-references.js';

export interface EditBody {
  error?: string; symbol_name: string; file_path: string; start_line: number; end_line: number; body: string;
  stable_id?: string | null; range_kind?: string; recovery?: unknown;
  declaration_line?: number;
  candidates?: unknown[]; total?: number;
}
export async function editBody(args: Record<string, unknown>, ctx: ToolContext) {
  const read = async (file?: string) => {
    const result = normalizeMcpToolResult(await getSymbolBody.handler({ ...args, ...(file ? { file_path: file } : {}), format: 'json' }, ctx));
    return { body: JSON.parse(result.text) as EditBody, sourceTruncations: result.sourceTruncations ?? [], source: 'current' };
  };
  try { return await read(); }
  catch (error) {
    ctx.signal?.throwIfAborted();
    if (args.file_path != null || !(error instanceof Error) || !error.message.includes('SYMBOL_NOT_FOUND')) throw error;
    const refs = normalizeMcpToolResult(await findReferences.handler({ project_name: args.project_name, symbol_name: args.symbol_name,
      source: 'disk', search_path: args.search_path, format: 'json', limit: 20 }, ctx));
    const data = JSON.parse(refs.text) as { references: Array<{ file_path: string }>; recovery?: unknown };
    for (const path of [...new Set(data.references.map(r => r.file_path))].slice(0, 5)) {
      try { const found = await read(path); return { ...found, source: 'disk_fallback' }; }
      catch (failure) { ctx.signal?.throwIfAborted(); if (!(failure instanceof Error) || !failure.message.includes('SYMBOL_NOT_FOUND')) throw failure; }
    }
    throw new Error(`[SYMBOL_NOT_FOUND] Symbol not found in the bounded discovery page. Pass file_path or narrow search_path.`
      + (data.recovery ? ' Continue: ' + JSON.stringify(data.recovery) : ''));
  }
}

export function addEditCap(caps: McpSourceTruncation[], technique: string, total: number, shown: number) {
  if (shown < total) caps.push({ technique, inputSize: total, outputSize: shown, unit: 'items', recoverable: true });
}
