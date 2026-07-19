/**
 * Server-side secret-decrypt port — lets main-process code (and, via the
 * worker bridge, `db_*` tools in workers) decrypt saved `enc:`/`plain:` secret
 * blobs WITHOUT importing `electron`.
 *
 * The real decryptor is `decryptSecretBlob` (apps/electron/src/secrets-ipc.ts,
 * safeStorage/DPAPI) — the Electron boot injects it via
 * `setMainSecretDecryptor` right after `mountSecretsIpc()`. In deployments
 * without Electron (dev-http / tests) the getter falls back to a decoder that
 * handles `plain:<b64>` blobs and refuses keychain-encrypted ones with a clear
 * error — never echoing the blob itself.
 *
 * Workers reach this through the `secretsDecrypt` bridge handler
 * (sse/worker-secrets-handlers.ts); module globals do NOT cross
 * worker_threads, so the worker side must always RPC here.
 */

export type SecretDecryptor = (blob: string) => string;

let mainDecryptor: SecretDecryptor | null = null;

/**
 * Fallback for a process where no Electron decryptor was injected. Mirrors the
 * real decryptor's contract for the cases it CAN handle: empty/untagged blobs
 * → '' and `plain:<b64>` → utf8. `enc:` blobs need the OS keychain, so throw a
 * clear, blob-free error instead of silently returning '' (which would attempt
 * auth with an empty password).
 */
function fallbackDecrypt(blob: string): string {
  if (typeof blob !== 'string' || blob.length === 0) return '';
  if (blob.startsWith('plain:')) return Buffer.from(blob.slice(6), 'base64').toString('utf8');
  if (blob.startsWith('enc:')) {
    throw new Error(
      'secret is keychain-encrypted — open via the Electron app to decrypt saved credentials',
    );
  }
  return '';
}

/** Inject the real (safeStorage-backed) decryptor. Call once from Electron boot. */
export function setMainSecretDecryptor(fn: SecretDecryptor | null): void {
  mainDecryptor = fn;
}

/** Always returns a usable function — the injected decryptor, else the fallback. */
export function getMainSecretDecryptor(): SecretDecryptor {
  return mainDecryptor ?? fallbackDecrypt;
}
