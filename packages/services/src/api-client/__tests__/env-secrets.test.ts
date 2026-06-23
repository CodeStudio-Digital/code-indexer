/**
 * Tests for environment secret masking — especially the regression where
 * un-toggling a masked secret used to persist the literal '••••'.
 */
import { describe, it, expect } from 'vitest';
import { maskSecrets, mergeSecrets, SECRET_MASK } from '../env-secrets.js';

describe('maskSecrets', () => {
  it('masks only secret values, leaves plain ones', () => {
    const out = JSON.parse(maskSecrets(JSON.stringify({
      token: { value: 'abc123', secret: true },
      page: { value: '1', secret: false },
      raw: 'plain',
    })));
    expect(out.token.value).toBe(SECRET_MASK);
    expect(out.page.value).toBe('1');
    expect(out.raw).toBe('plain');
  });

  it('returns input unchanged on invalid JSON', () => {
    expect(maskSecrets('not json')).toBe('not json');
  });
});

describe('mergeSecrets', () => {
  const existing = JSON.stringify({ token: { value: 'real-secret', secret: true } });

  it('restores the stored value when the client sends the mask back', () => {
    const merged = mergeSecrets({ token: { value: SECRET_MASK, secret: true } }, existing);
    expect((merged.token as { value: string }).value).toBe('real-secret');
  });

  it('restores even when the user UNTOGGLES secret (the bug fix)', () => {
    // value still masked + secret turned off → must NOT persist '••••'
    const merged = mergeSecrets({ token: { value: SECRET_MASK, secret: false } }, existing);
    expect((merged.token as { value: string }).value).toBe('real-secret');
  });

  it('keeps a genuinely new value the user typed', () => {
    const merged = mergeSecrets({ token: { value: 'new-secret', secret: true } }, existing);
    expect((merged.token as { value: string }).value).toBe('new-secret');
  });

  it('handles a missing prior value gracefully', () => {
    const merged = mergeSecrets({ fresh: { value: SECRET_MASK, secret: true } }, existing);
    expect((merged.fresh as { value: string }).value).toBe('');
  });
});
