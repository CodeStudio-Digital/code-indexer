import { describe, it, expect } from 'vitest';
import { encryptSecret, decryptSecret, isHardwareBacked } from '../index.js';

/**
 * In a plain Node test there is no `window.electronAPI`, so the bridge is null
 * and the helpers degrade to passthrough. This pins that contract (the
 * browser-dev / headless behaviour). The real device-bound path (safeStorage)
 * is exercised manually under Electron.
 */
describe('@mcp/secret-box (no bridge / browser-dev)', () => {
  it('reports no hardware backing without a bridge', () => {
    expect(isHardwareBacked()).toBe(false);
  });

  it('passes plaintext through encrypt/decrypt unchanged', async () => {
    const secret = 'hunter2:correct-horse';
    const enc = await encryptSecret(secret);
    expect(enc).toBe(secret); // passthrough, not ciphertext
    expect(await decryptSecret(enc)).toBe(secret);
  });

  it('treats empty/null as empty string', async () => {
    expect(await encryptSecret('')).toBe('');
    expect(await decryptSecret(null)).toBe('');
    expect(await decryptSecret('')).toBe('');
  });
});
