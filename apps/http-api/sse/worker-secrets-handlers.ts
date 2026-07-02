/**
 * Main-side bridge handler for secret decryption (workers → main).
 *
 * Saved credentials (db-client, SSH) are `enc:<b64>` blobs cipher-bound to the
 * OS keychain via Electron `safeStorage` — which only exists in the main
 * process. Workers (coder-worker + company-worker) cannot decrypt locally, so
 * the `db_*` tools RPC here via `bridge.request('secretsDecrypt', { blob })`.
 *
 * The actual decryptor is resolved through the server-side port
 * (`server/secret-decrypt-port.ts`): Electron boot injects the real
 * safeStorage decryptor; without it the port's fallback handles `plain:` and
 * refuses `enc:` with a clear error (never echoing the blob).
 *
 * Registered per worker spawn by `CoderWorkerPool` / `WorkerOrchestratorPool`
 * next to the memory/vision handlers.
 */
import { getMainSecretDecryptor } from '../server/secret-decrypt-port.js';

/** Minimal structural slice of MessageBridge used here (test-friendly). */
interface BridgeLike {
  handle(name: string, fn: (payload: unknown) => Promise<unknown>): () => void;
}

/**
 * Register the secrets handler on a worker bridge. Returns a disposer to call
 * from the pool's `detachBusMirror`.
 */
export function registerWorkerSecretsHandlers(bridge: BridgeLike): () => void {
  const offDecrypt = bridge.handle('secretsDecrypt', async (payload) => {
    const { blob } = payload as { blob: string };
    return getMainSecretDecryptor()(blob);
  });

  return (): void => {
    try { offDecrypt(); } catch { /* best-effort */ }
  };
}
