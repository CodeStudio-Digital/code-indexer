import { describe, it, expect, beforeEach, vi } from 'vitest';

/**
 * Behavior of the server-side secret-decrypt port. The port keeps MODULE-level
 * state (the injected decryptor), so each test re-imports a fresh copy via
 * `vi.resetModules()` — no cross-test bleed.
 */
async function freshPort() {
  return import('../secret-decrypt-port.js');
}

beforeEach(() => {
  vi.resetModules();
});

describe('secret-decrypt-port fallback (no Electron decryptor injected)', () => {
  it('decodes plain:<b64> blobs', async () => {
    const { getMainSecretDecryptor } = await freshPort();
    const blob = `plain:${Buffer.from('hunter2', 'utf8').toString('base64')}`;
    expect(getMainSecretDecryptor()(blob)).toBe('hunter2');
  });

  it('returns "" for empty or untagged blobs (mirrors decryptSecretBlob)', async () => {
    const { getMainSecretDecryptor } = await freshPort();
    expect(getMainSecretDecryptor()('')).toBe('');
    expect(getMainSecretDecryptor()('not-a-tagged-blob')).toBe('');
  });

  it('throws a clear error on enc: blobs — without echoing the blob', async () => {
    const { getMainSecretDecryptor } = await freshPort();
    const ciphertext = Buffer.from('super-secret-ciphertext').toString('base64');
    const blob = `enc:${ciphertext}`;
    let caught: unknown;
    try {
      getMainSecretDecryptor()(blob);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    const msg = (caught as Error).message;
    expect(msg).toMatch(/keychain-encrypted/i);
    expect(msg).toMatch(/Electron/i);
    expect(msg).not.toContain(ciphertext); // never leak the blob
    expect(msg).not.toContain(blob);
  });
});

describe('setMainSecretDecryptor', () => {
  it('replaces the fallback with the injected decryptor', async () => {
    const { setMainSecretDecryptor, getMainSecretDecryptor } = await freshPort();
    const real = vi.fn((blob: string) => `decrypted(${blob})`);
    setMainSecretDecryptor(real);
    expect(getMainSecretDecryptor()('enc:abc')).toBe('decrypted(enc:abc)');
    expect(real).toHaveBeenCalledWith('enc:abc');
  });
});
