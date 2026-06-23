/**
 * Secret shim — encrypt/decrypt sensitive values with the OS keychain
 * (`safeStorage`) so saved credentials are never stored as plaintext in the
 * local SQLite DB. Both directions are renderer-callable: the renderer encrypts
 * before saving and decrypts just before building a connect spec. Plaintext only
 * ever lives transiently in main + renderer memory; the at-rest blob in SQLite
 * is keychain ciphertext.
 *
 * Output is a tagged base64 string so we can degrade cleanly on a machine
 * without an OS keychain (rare bare Linux): `enc:<b64>` = keychain-encrypted,
 * `plain:<b64>` = not encryptable here (still obfuscated, never raw).
 *
 * This is the GENERALIZED home of the device-bound secret primitive: the SSH
 * client, the database client, and any future sensitive store all share these
 * `secrets:*` channels. The legacy `ssh:encryptSecret`/`ssh:decryptSecret`
 * channels are registered here too as aliases so migration 173 + the SSH
 * renderer keep working untouched.
 */

import { ipcMain, safeStorage } from 'electron';

/** Encrypt a plaintext secret into a tagged, at-rest-safe blob. */
export function encryptSecretBlob(plain: unknown): string {
  if (typeof plain !== 'string' || plain.length === 0) return '';
  if (!safeStorage.isEncryptionAvailable()) {
    return `plain:${Buffer.from(plain, 'utf8').toString('base64')}`;
  }
  return `enc:${safeStorage.encryptString(plain).toString('base64')}`;
}

/** Decrypt a tagged blob back to plaintext. THROWS on an undecryptable `enc:` blob. */
export function decryptSecretBlob(blob: unknown): string {
  if (typeof blob !== 'string' || blob.length === 0) return ''; // genuinely-empty secret
  if (blob.startsWith('plain:')) return Buffer.from(blob.slice(6), 'base64').toString('utf8');
  if (blob.startsWith('enc:')) {
    // THROW (not '') on an undecryptable blob — e.g. a different OS user or a
    // wiped keychain. Returning '' would silently attempt auth with an EMPTY
    // password/key; failing fast lets the UI prompt to re-enter the secret.
    return safeStorage.decryptString(Buffer.from(blob.slice(4), 'base64'));
  }
  return '';
}

/**
 * Register the neutral `secrets:*` channels plus the legacy `ssh:*` aliases.
 * Call ONCE from the main process (replaces the old `mountSshSecretsIpc`).
 */
export function mountSecretsIpc(): void {
  ipcMain.handle('secrets:encrypt', (_e, plain: unknown): string => encryptSecretBlob(plain));
  ipcMain.handle('secrets:decrypt', (_e, blob: unknown): string => decryptSecretBlob(blob));
  // Legacy aliases — keep the SSH renderer + migration 173 working untouched.
  ipcMain.handle('ssh:encryptSecret', (_e, plain: unknown): string => encryptSecretBlob(plain));
  ipcMain.handle('ssh:decryptSecret', (_e, blob: unknown): string => decryptSecretBlob(blob));
}
