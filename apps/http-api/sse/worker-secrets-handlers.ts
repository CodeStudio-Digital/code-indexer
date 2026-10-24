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
import {
  getMainSecretDecryptor,
  getMainSecretEncryptor,
} from '../server/secret-decrypt-port.js';

/** Minimal structural slice of MessageBridge used here (test-friendly). */
interface BridgeLike {
  handle(name: string, fn: (payload: unknown) => Promise<unknown>): () => void;
}

/**
 * Register the secrets handler on a worker bridge. Returns a disposer to call
 * from the pool's `detachBusMirror`.
 */
export function registerWorkerSecretsHandlers(bridge: BridgeLike, owner?: (runId: unknown) => () => void): () => void {
  const offDecrypt = bridge.handle('secretsDecrypt', async (payload) => {
    const { blob, runId } = payload as { blob: string; runId?: unknown };
    const assertOwner = owner?.(runId); assertOwner?.();
    // await, not return: the decryptor may be an out-of-process RPC once the
    // backend no longer shares an address space with safeStorage.
    const result = await getMainSecretDecryptor()(blob);
    assertOwner?.(); return result;
  });
  const offEncrypt = bridge.handle('secretsEncrypt', async (payload) => {
    const { plaintext, runId } = payload as { plaintext: string; runId?: unknown };
    const assertOwner = owner?.(runId); assertOwner?.();
    const result = await getMainSecretEncryptor()(plaintext);
    assertOwner?.(); return result;
  });

  return (): void => {
    try { offDecrypt(); } catch { /* best-effort */ }
    try { offEncrypt(); } catch { /* best-effort */ }
  };
}
