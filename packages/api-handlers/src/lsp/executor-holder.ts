/**
 * Module-singleton box for the active LspBackendExecutor.
 *
 * `createLspHandlers(deps)` is instantiated 2-3× on Electron (IPC mount,
 * Hono dispatch fallback, agent adapter in server.ts) — a factory-held
 * executor would let some instances keep computing synchronously on the
 * main thread while others use the worker. The box guarantees every
 * instance dispatches to the same place. Unset (early boot, tests) means
 * callers use their local in-process default.
 */
import type { LspBackendExecutor } from './executor-types.js';

let executor: LspBackendExecutor | null = null;

export function setLspExecutor(e: LspBackendExecutor): void {
  executor = e;
}

export function getLspExecutor(): LspBackendExecutor | null {
  return executor;
}
