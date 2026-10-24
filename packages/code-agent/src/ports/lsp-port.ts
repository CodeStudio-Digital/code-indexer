import type { DiagnosticResult, HoverResult, TsPosition } from '../lsp/ts-service.js';

export interface AgentLspQuery {
  op: 'definition' | 'references' | 'hover' | 'diagnostics';
  root: string; projectName: string; file: string;
  line?: number; column?: number; offset?: number; limit?: number;
}
export type AgentLspPage = { total: number; offset: number; nextOffset?: number } & (
  { kind: 'locations'; items: Array<TsPosition & { isWriteAccess?: boolean }> } |
  { kind: 'diagnostics'; items: DiagnosticResult[] });
export type AgentLspAnswer = AgentLspPage | { kind: 'hover'; hover: HoverResult | null };
export interface AgentLspPort {
  query(input: AgentLspQuery, signal?: AbortSignal): Promise<AgentLspAnswer>;
}

export function lspPage<T>(items: T[], input: Pick<AgentLspQuery, 'offset' | 'limit'>) {
  const offset = input.offset ?? 0, limit = input.limit ?? 200;
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 500) throw new Error('Invalid LSP page (limit 1..500, offset >= 0)');
  return { items: items.slice(offset, offset + limit), total: items.length, offset,
    ...(offset + limit < items.length ? { nextOffset: offset + limit } : {}) };
}
