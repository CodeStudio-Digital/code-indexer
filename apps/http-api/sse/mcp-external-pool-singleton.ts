import { McpExternalPool } from './mcp-external-pool-runtime.js';

/**
 * Process-level singleton — set by `apps/http-api/server.ts` after
 * the pool boots. Read by `CoderWorkerPool` to wire the bridge
 * handlers. Plain mutable box so server.ts owns lifecycle (boot,
 * shutdown) without an extra ceremony.
 */
let globalPool: McpExternalPool | null = null;

export function setGlobalMcpExternalPool(pool: McpExternalPool | null): void {
  globalPool = pool;
}

export function getGlobalMcpExternalPool(): McpExternalPool | null {
  return globalPool;
}
