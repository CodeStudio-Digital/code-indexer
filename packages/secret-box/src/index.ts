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
 * back to the legacy `window.electronAPI.ssh` bridge for back-compat, and in
 * browser-dev (no Electron) degrades to a passthrough.
 *
 * Blob format (tagged base64), produced/consumed by the main-process shim:
 *   `enc:<b64>`   keychain ciphertext (device-bound) — useless off this machine
 *   `plain:<b64>` obfuscated fallback when no OS keychain (rare bare Linux)
 *   `v1:<json>`   @mcp/vault-crypto envelope (P3, passphrase vault) — routed elsewhere
 */

export interface SecretBridge {
  encrypt(plain: string): Promise<string>;
  decrypt(blob: string): Promise<string>;
}

interface ElectronSecretApi {
  secrets?: SecretBridge;
  ssh?: { encryptSecret(p: string): Promise<string>; decryptSecret(b: string): Promise<string> };
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

/**
 * Encrypt a secret with the OS keychain before persisting.
 * Empty input → empty string. Browser-dev (no bridge) → passthrough.
 */
export async function encryptSecret(plain: string): Promise<string> {
  if (!plain) return '';
  const bridge = getSecretBridge();
  return bridge ? bridge.encrypt(plain) : plain;
}

/**
 * Decrypt a stored secret just before use.
 * Empty/null input → empty string. Browser-dev (no bridge) → passthrough.
 * THROWS on an undecryptable `enc:` blob (different OS user / wiped keychain) so
 * the UI can prompt to re-enter rather than silently authenticating with empty.
 */
export async function decryptSecret(blob: string | null): Promise<string> {
  if (!blob) return '';
  const bridge = getSecretBridge();
  return bridge ? bridge.decrypt(blob) : blob;
}
