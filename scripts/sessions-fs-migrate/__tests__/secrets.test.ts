import { describe, expect, it, vi } from 'vitest';
import {
  sealCompanyEnvironmentRow,
  type SecretSealer,
} from '../secrets.js';

describe('Company secret migration', () => {
  it('leaves non-secret environment rows untouched', () => {
    const row = { id: 1, is_secret: 0, value: 'visible' };
    const sealer: SecretSealer = { seal: vi.fn() };

    expect(sealCompanyEnvironmentRow(row, sealer)).toBe(row);
    expect(sealer.seal).not.toHaveBeenCalled();
  });

  it('replaces plaintext with a keychain-backed ciphertext', () => {
    const seal = vi.fn(() => 'enc:Y2lwaGVydGV4dA==');
    const migrated = sealCompanyEnvironmentRow(
      { id: 2, is_secret: 1, value: 'plaintext' },
      { seal },
    );

    expect(seal).toHaveBeenCalledWith('plaintext');
    expect(migrated).toMatchObject({
      id: 2,
      is_secret: 1,
      encrypted_value: 'enc:Y2lwaGVydGV4dA==',
      encryption: 'electron_safe_storage',
    });
    expect(JSON.stringify(migrated)).not.toContain('"value"');
  });

  it('fails closed when a plaintext secret cannot be sealed', () => {
    const failure = new Error('OS keychain unavailable');
    expect(() =>
      sealCompanyEnvironmentRow(
        { id: 3, is_secret: 1, value: 'plaintext' },
        { seal: () => { throw failure; } },
      ),
    ).toThrow(failure);
  });

  it('rejects malformed secret rows without a string value', () => {
    expect(() =>
      sealCompanyEnvironmentRow(
        { id: 4, is_secret: 1, value: null },
        { seal: vi.fn() },
      ),
    ).toThrow('Company secret row has no string value');
  });
});
