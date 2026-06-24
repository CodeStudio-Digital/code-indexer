import { Agent, setGlobalDispatcher } from 'undici';

let installed = false;

/**
 * Install a streaming-resilient global undici dispatcher for the CURRENT realm.
 *
 * Node 24 (Electron 42) ships a newer undici whose default 5-minute
 * `bodyTimeout` measures the gap BETWEEN consecutive body chunks. A long silent
 * reasoning phase on an LLM stream can exceed it and abort the response, so we
 * disable that inactivity timeout (the runner still owns its own AbortSignal
 * for genuine cancellation).
 *
 * Idempotent. Must run in EVERY realm that issues provider fetches — each
 * coder/company `worker_thread` has its OWN global dispatcher, plus the main
 * process. Best-effort: never blocks boot if undici/Agent is unavailable.
 *
 * Pairs with `withStreamResilience` (@mcp/provider-sdk), which handles the
 * separate "Premature close" class on completed streams.
 */
export function installLlmDispatcher(): void {
  if (installed) return;
  installed = true;
  try {
    setGlobalDispatcher(new Agent({ bodyTimeout: 0 }));
  } catch {
    // Keep the default dispatcher rather than fail boot.
  }
}
