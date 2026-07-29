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

/**
 * Returns plaintext, or a promise of it.
 *
 * The async arm exists for a host where the real decryptor lives in ANOTHER
 * process: `safeStorage` is an Electron main-process API, so once the backend
 * moves into a `utilityProcess` this port is satisfied by an RPC back to main
 * rather than a direct call. Both existing consumers already tolerate a
 * promise — `DbSecretDecryptor` (packages/code-agent/src/tools/db/store-binding.ts)
 * is declared `Promise<string> | string`, and the worker bridge handler awaits
 * its return — so widening it here is not a breaking change today.
 */
export type SecretDecryptor = (blob: string) => string | Promise<string>;
export type SecretEncryptor = (plaintext: string) => string | Promise<string>;

let mainDecryptor: SecretDecryptor | null = null;
let mainEncryptor: SecretEncryptor | null = null;

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

function fallbackEncrypt(_plaintext: string): never {
  throw new Error(
    'OS keychain encryption is unavailable — refusing to persist a Company session secret',
  );
}

export function setMainSecretEncryptor(fn: SecretEncryptor | null): void {
  mainEncryptor = fn;
}

/** Fail-closed counterpart to getMainSecretDecryptor. */
export function getMainSecretEncryptor(): SecretEncryptor {
  return mainEncryptor ?? fallbackEncrypt;
}
