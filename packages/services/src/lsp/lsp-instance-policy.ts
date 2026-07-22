import type { LspManagerEntry } from './lsp-server-manager-types.js';

/** Four attempts before the honest failed lock; tolerates slow disk/AV startup. */
export const LSP_BACKOFF_MS = [1_000, 3_000, 8_000, 20_000] as const;
const CRASH_WINDOW_MS = 5 * 60_000;

export function inLspFailureWindow(entry: LspManagerEntry): boolean {
  const now = Date.now();
  entry.crashTimes = entry.crashTimes.filter((time) => now - time < CRASH_WINDOW_MS);
  return entry.crashTimes.length >= LSP_BACKOFF_MS.length;
}

export function lspIdleMs(): number {
  const value = Number(process.env.MCP_LSP_IDLE_MS);
  return Number.isFinite(value) && value > 0 ? value : 600_000;
}

export function lspWarmProjectLimit(): number {
  const value = Number(process.env.MCP_LSP_WARM_PROJECTS);
  return Number.isFinite(value) && value >= 0 ? Math.floor(value) : 2;
}
