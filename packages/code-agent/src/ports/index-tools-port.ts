import type { CodeIndexDB } from '@mcp/store/db.js';

/** One index tool as the server publishes it (name, description, JSON schema). */
export interface IndexToolCatalogEntry {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/** The CallToolResult a stdio client would decode for the same call. */
export interface IndexToolCallResult {
  content?: unknown;
  structuredContent?: unknown;
  isError?: boolean;
  _meta?: Record<string, unknown>;
}

/**
 * In-process index tools. The Host builds the implementation (the indexer's
 * agent-tools) and registers it per process; the agent never imports it.
 * Calls run over the caller's database handle.
 */
export interface IndexToolsPort {
  catalog(): readonly IndexToolCatalogEntry[];
  invoke(
    name: string,
    args: Record<string, unknown>,
    ctx: { db: CodeIndexDB; signal?: AbortSignal },
  ): Promise<IndexToolCallResult>;
}

let globalIndexTools: IndexToolsPort | null = null;

/** Called by each Host process (worker) at boot; `null` unregisters. */
export function setGlobalIndexTools(port: IndexToolsPort | null): void {
  globalIndexTools = port;
}

export function getGlobalIndexTools(): IndexToolsPort | null {
  return globalIndexTools;
}
