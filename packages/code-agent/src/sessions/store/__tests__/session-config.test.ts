/**
 * Onda 3c (Codex parity): session config lock. The pure build/diff logic
 * (get/set are DB-backed and covered by the Electron-ABI suite). Contract:
 *   - buildConfigLock normalizes undefined → null
 *   - diffConfigLock reports drifted knobs and ignores capturedAtMs
 */
import { describe, it, expect } from 'vitest';
import { buildConfigLock, diffConfigLock } from '../session-config.js';

const base = {
  provider: 'anthropic',
  model: 'claude-opus-4-8',
  permissionMode: 'auto',
  nowMs: 1000,
};

describe('buildConfigLock', () => {
  it('normalizes missing knobs to null and stamps capture time', () => {
    const lock = buildConfigLock(base);
    expect(lock.reasoningEffort).toBeNull();
    expect(lock.temperature).toBeNull();
    expect(lock.capturedAtMs).toBe(1000);
    expect(lock.model).toBe('claude-opus-4-8');
  });
});

describe('diffConfigLock', () => {
  it('returns no drift for identical config (ignoring capture time)', () => {
    const a = buildConfigLock(base);
    const b = buildConfigLock({ ...base, nowMs: 9999 });
    expect(diffConfigLock(a, b)).toEqual([]);
  });

  it('reports drifted fields as old → new', () => {
    const stored = buildConfigLock(base);
    const current = buildConfigLock({ ...base, model: 'claude-sonnet-5', permissionMode: 'unrestricted' });
    const drift = diffConfigLock(stored, current);
    expect(drift).toContain('model: claude-opus-4-8 → claude-sonnet-5');
    expect(drift).toContain('permissionMode: auto → unrestricted');
    expect(drift).toHaveLength(2);
  });
});
