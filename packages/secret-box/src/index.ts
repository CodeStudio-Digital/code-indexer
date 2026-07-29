/**
 * @mcp/secret-box — renderer-facing device-bound secret helper.
 *
 * Thin wrapper over the Electron preload `secrets:*` IPC (OS keychain via
 * `safeStorage`: Windows DPAPI / macOS Keychain / Linux libsecret). The renderer
 * encrypts a secret BEFORE persisting it (so SQLite only ever holds tagged
 * ciphertext) and decrypts it just-in-time before building a live connect spec.
 * Plaintext never touches disk and never crosses a remote — only the in-process
 * IPC channel.
 *
 * This is the reusable extraction shared by the SSH client, the database client,
 * and future sensitive stores. It reads `window.electronAPI.secrets`, falling
 * back to the legacy `window.electronAPI.ssh` bridge for back-compat.
 *
 * WITHOUT a bridge (a plain browser under `vite dev`) this used to be a silent
 * PASSTHROUGH: raw SSH passwords, private keys, DB passwords and SSL keys were
 * written verbatim into columns whose entire contract is "ciphertext". It now
 * FAILS LOUDLY instead. A developer who genuinely wants a throwaway dev DB opts
 * in via `VITE_MCP_ALLOW_INSECURE_SECRETS=1`, and even then the value is tagged
 * `dev-plain:` so the UI can flag it — the raw string is never what lands in
 * the column.
 *
 * Blob format (tagged base64), produced/consumed by the main-process shim:
 *   `enc:<b64>`       keychain ciphertext (device-bound) — useless off this machine
 *   `plain:<b64>`     obfuscated fallback when the MACHINE has no OS keychain
 *   `dev-plain:<b64>` NOT encrypted — written by a browser with no bridge (opt-in)
 *   `v1:<json>`       @mcp/vault-crypto envelope (P3, passphrase vault) — routed elsewhere
 *
 * `plain:` and `dev-plain:` are deliberately distinct tags. `plain:` is a
 * knowing main-process decision on a keychain-less box; `dev-plain:` means a
 * browser wrote a credential in the clear. Collapsing them would make the
 * dangerous state unauditable.
 */

export interface SecretBridge {
  encrypt(plain: string): Promise<string>;
  decrypt(blob: string): Promise<string>;
}

interface ElectronSecretApi {
  secrets?: SecretBridge;
  ssh?: { encryptSecret(p: string): Promise<string>; decryptSecret(b: string): Promise<string> };
}

/** Tag for a secret that was never actually encrypted (browser dev, opt-in only). */
export const DEV_PLAIN_PREFIX = 'dev-plain:';

/** Thrown when a credential would have to be stored — or read — without the keychain. */
export class SecretBridgeUnavailableError extends Error {
  readonly code = 'secret_bridge_unavailable';
  constructor(message: string) {
    super(message);
    this.name = 'SecretBridgeUnavailableError';
  }
}

/** Resolve the preload-exposed secret bridge, or null in browser-dev. */
export function getSecretBridge(): SecretBridge | null {
  const api = (globalThis as { electronAPI?: ElectronSecretApi }).electronAPI;
  if (!api) return null;
  if (api.secrets) return api.secrets;
  if (api.ssh) {
    // Legacy bridge — same channels, different names.
    return { encrypt: (p) => api.ssh!.encryptSecret(p), decrypt: (b) => api.ssh!.decryptSecret(b) };
  }
  return null;
}

/** True when a hardware/OS keychain backs encryption (i.e. running under Electron). */
export function isHardwareBacked(): boolean {
  return getSecretBridge() !== null;
}

/** True for a stored blob that is base64 only — a credential sitting in the clear. */
export function isDevPlainSecret(blob: string | null | undefined): boolean {
  return typeof blob === 'string' && blob.startsWith(DEV_PLAIN_PREFIX);
}

/**
 * Tags that mean "stored the way this machine can store it".
 *
 * `plain:` belongs here even though it is only base64: it is a KNOWING
 * main-process decision on a box with no OS keychain (rare bare Linux), and
 * there is nothing the user could do about it — flagging it would be a
 * permanent, unactionable warning. `dev-plain:` is deliberately absent: that
 * one is actionable (run the desktop app and re-enter the secret).
 */
const STORED_TAGS = ['enc:', 'plain:', 'v1:'];

/**
 * True for a stored credential that is NOT encrypted — either the opt-in
 * `dev-plain:` tag, or an UNTAGGED blob, which is a raw plaintext write from
 * the era when a missing bridge silently passed through. The untagged case is
 * the one that matters in practice: those rows already exist on disk in
 * databases written before that hole was closed, and nothing else can spot them
 * (they look like an ordinary password because they are one). Surfaced in the
 * UI so the user can re-enter and re-seal the affected credentials.
 */
export function isUnencryptedSecret(blob: string | null | undefined): boolean {
  if (typeof blob !== 'string' || blob.length === 0) return false;
  return !STORED_TAGS.some((t) => blob.startsWith(t));
}

const INSECURE_FLAG = 'VITE_MCP_ALLOW_INSECURE_SECRETS';

/**
 * Opt-in escape hatch for running the dashboard in a plain browser. Off by
 * default. Both env surfaces are read because neither exists everywhere:
 * `import.meta.env` only under a bundler, `process.env` only under Node.
 */
export function insecureSecretsAllowed(): boolean {
  try {
    const env = (import.meta as { env?: Record<string, string | undefined> }).env;
    if (env?.[INSECURE_FLAG] === '1') return true;
  } catch {
    /* no bundler-injected import.meta.env */
  }
  try {
    return (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.[INSECURE_FLAG] === '1';
  } catch {
    return false;
  }
}

// btoa/atob are latin1-only; go through UTF-8 explicitly so a non-ASCII
// passphrase round-trips instead of being mangled.
const toB64 = (s: string): string => {
  const bytes = new TextEncoder().encode(s);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
};
const fromB64 = (s: string): string =>
  new TextDecoder().decode(Uint8Array.from(atob(s), (c) => c.charCodeAt(0)));

/**
 * Encrypt a secret with the OS keychain before persisting.
 * Empty input → empty string. No bridge → throws, unless explicitly opted in.
 */
export async function encryptSecret(plain: string): Promise<string> {
  if (!plain) return '';
  const bridge = getSecretBridge();
  if (bridge) return bridge.encrypt(plain);
  if (!insecureSecretsAllowed()) {
    throw new SecretBridgeUnavailableError(
      'No OS keychain bridge — refusing to store a credential unencrypted. Run the desktop app, ' +
        'or set VITE_MCP_ALLOW_INSECURE_SECRETS=1 for a throwaway dev database.',
    );
  }
  return `${DEV_PLAIN_PREFIX}${toB64(plain)}`;
}

/**
 * Decrypt a stored secret just before use.
 * Empty/null input → empty string. THROWS on an undecryptable `enc:` blob
 * (different OS user / wiped keychain) so the UI can prompt to re-enter rather
 * than silently authenticating with an empty password.
 */
export async function decryptSecret(blob: string | null): Promise<string> {
  if (!blob) return '';
  const bridge = getSecretBridge();
  if (bridge) return bridge.decrypt(blob);
  // Browser dev: only the base64-tagged forms are readable without a keychain.
  if (blob.startsWith(DEV_PLAIN_PREFIX)) return fromB64(blob.slice(DEV_PLAIN_PREFIX.length));
  if (blob.startsWith('plain:')) return fromB64(blob.slice('plain:'.length));
  // An `enc:` blob is device-bound safeStorage ciphertext; an untagged one is a
  // legacy passthrough write. Handing either back verbatim would feed ciphertext
  // to ssh2/the DB driver as if it were the password — fail loudly instead.
  throw new SecretBridgeUnavailableError(
    'Cannot decrypt a device-bound secret outside the desktop app.',
  );
}
