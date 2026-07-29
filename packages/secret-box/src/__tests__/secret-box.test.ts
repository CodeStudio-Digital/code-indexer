import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import {
  encryptSecret,
  decryptSecret,
  isHardwareBacked,
  isDevPlainSecret,
  isUnencryptedSecret,
  getSecretBridge,
  SecretBridgeUnavailableError,
  DEV_PLAIN_PREFIX,
} from '../index.js';

/**
 * Regression — without `window.electronAPI` these helpers used to PASS PLAINTEXT
 * THROUGH, so running the dashboard in a plain browser wrote raw SSH passwords,
 * private keys and DB credentials into columns whose contract is "ciphertext"
 * (`ssh_hosts.enc_password`, `db_connections.enc_password`, …). The silent
 * degrade is the bug: it looks encrypted at every call site and at rest.
 *
 * The contract is now: no bridge → THROW, unless the developer explicitly opted
 * in, and even then the stored value is tagged `dev-plain:` so it is auditable
 * and never the raw string. The real device-bound path (safeStorage) is
 * exercised manually under Electron.
 */
describe('@mcp/secret-box (no bridge / browser-dev)', () => {
  beforeEach(() => {
    // A repo `.env` leaks into vitest via process.env, and the opt-in flag is
    // now read from there too — pin it OFF so the refusal tests can't pass
    // vacuously on a machine that happens to have it set.
    vi.stubEnv('VITE_MCP_ALLOW_INSECURE_SECRETS', '');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    delete (globalThis as { electronAPI?: unknown }).electronAPI;
  });

  it('reports no hardware backing without a bridge', () => {
    expect(isHardwareBacked()).toBe(false);
    expect(getSecretBridge()).toBeNull();
  });

  it('REFUSES to encrypt without a bridge rather than storing plaintext', async () => {
    await expect(encryptSecret('hunter2:correct-horse')).rejects.toThrow(SecretBridgeUnavailableError);
    await expect(encryptSecret('hunter2')).rejects.toMatchObject({ code: 'secret_bridge_unavailable' });
  });

  it('REFUSES to hand back a device-bound blob it cannot decrypt', async () => {
    // Returning this verbatim would feed ciphertext to ssh2 as the password.
    await expect(decryptSecret('enc:AAAA')).rejects.toThrow(SecretBridgeUnavailableError);
    // An untagged blob is a legacy passthrough write — equally unusable.
    await expect(decryptSecret('hunter2')).rejects.toThrow(SecretBridgeUnavailableError);
  });

  it('treats empty/null as empty string, never as a failure', async () => {
    expect(await encryptSecret('')).toBe('');
    expect(await decryptSecret(null)).toBe('');
    expect(await decryptSecret('')).toBe('');
  });

  it('still reads a `plain:` blob written by a keychain-less main process', async () => {
    expect(await decryptSecret(`plain:${btoa('hunter2')}`)).toBe('hunter2');
  });

  describe('with VITE_MCP_ALLOW_INSECURE_SECRETS=1 (explicit dev opt-in)', () => {
    it('tags the value instead of storing it raw, and round-trips it', async () => {
      vi.stubEnv('VITE_MCP_ALLOW_INSECURE_SECRETS', '1');
      const secret = 'hunter2:correct-horse';
      const stored = await encryptSecret(secret);
      expect(stored).not.toBe(secret); // never the raw string
      expect(stored.startsWith(DEV_PLAIN_PREFIX)).toBe(true);
      expect(isDevPlainSecret(stored)).toBe(true);
      expect(await decryptSecret(stored)).toBe(secret);
    });

    it('round-trips a non-ASCII passphrase (btoa alone would mangle it)', async () => {
      vi.stubEnv('VITE_MCP_ALLOW_INSECURE_SECRETS', '1');
      const secret = 'sênha-çom-acento-🔑';
      expect(await decryptSecret(await encryptSecret(secret))).toBe(secret);
    });
  });

  it('isDevPlainSecret only flags the unencrypted tag', () => {
    expect(isDevPlainSecret('dev-plain:AAAA')).toBe(true);
    expect(isDevPlainSecret('enc:AAAA')).toBe(false);
    expect(isDevPlainSecret('plain:AAAA')).toBe(false);
    expect(isDevPlainSecret(null)).toBe(false);
    expect(isDevPlainSecret(undefined)).toBe(false);
  });

  it('isUnencryptedSecret also catches the LEGACY untagged passthrough writes', () => {
    // The rows that already exist on disk: a raw password stored as-is.
    expect(isUnencryptedSecret('hunter2')).toBe(true);
    expect(isUnencryptedSecret('-----BEGIN OPENSSH PRIVATE KEY-----')).toBe(true);
    expect(isUnencryptedSecret('dev-plain:AAAA')).toBe(true);
    // Legitimately stored forms are not flagged.
    expect(isUnencryptedSecret('enc:AAAA')).toBe(false);
    expect(isUnencryptedSecret('plain:AAAA')).toBe(false);
    expect(isUnencryptedSecret('v1:{}')).toBe(false);
    // Absence of a secret is not an insecure secret.
    expect(isUnencryptedSecret('')).toBe(false);
    expect(isUnencryptedSecret(null)).toBe(false);
  });
});

describe('@mcp/secret-box (with a bridge)', () => {
  afterEach(() => {
    delete (globalThis as { electronAPI?: unknown }).electronAPI;
  });

  it('prefers the neutral `secrets` bridge', async () => {
    (globalThis as { electronAPI?: unknown }).electronAPI = {
      secrets: { encrypt: async (p: string) => `enc:${p}`, decrypt: async (b: string) => b.slice(4) },
    };
    expect(isHardwareBacked()).toBe(true);
    expect(await encryptSecret('pw')).toBe('enc:pw');
    expect(await decryptSecret('enc:pw')).toBe('pw');
  });

  it('falls back to the legacy `ssh` bridge', async () => {
    (globalThis as { electronAPI?: unknown }).electronAPI = {
      ssh: { encryptSecret: async (p: string) => `enc:${p}`, decryptSecret: async (b: string) => b.slice(4) },
    };
    expect(await encryptSecret('pw')).toBe('enc:pw');
    expect(await decryptSecret('enc:pw')).toBe('pw');
  });
});
