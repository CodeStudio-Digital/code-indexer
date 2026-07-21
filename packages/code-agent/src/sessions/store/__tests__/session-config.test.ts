/**
 * Onda 3c (Codex parity): session config lock. The pure build/diff logic
 * (get/set are DB-backed and covered by the Electron-ABI suite). Contract:
 *   - buildConfigLock normalizes undefined → null
 *   - diffConfigLock reports drifted knobs and ignores capturedAtMs
 */
import { describe, it, expect } from 'vitest';
import { buildConfigLock, diffConfigLock, normalizeConfigLock } from '../session-config.js';

const base = {
  provider: 'anthropic',
  model: 'claude-opus-4-8',
  permissionMode: 'auto',
  nowMs: 1000,
};

describe('buildConfigLock', () => {
  it('normalizes missing knobs to null and stamps capture time', () => {
    const lock = buildConfigLock(base);
    expect(lock.executionMode).toBe('standard');
    expect(lock.reasoningEffort).toBeNull();
    expect(lock.temperature).toBeNull();
    expect(lock.capturedAtMs).toBe(1000);
    expect(lock.model).toBe('claude-opus-4-8');
  });

  it('converts a legacy ultra effort into orchestration mode', () => {
    const lock = buildConfigLock({ ...base, reasoningEffort: ' Ultra ' });
    expect(lock.executionMode).toBe('ultra');
    expect(lock.reasoningEffort).toBeNull();
  });

  it('keeps an explicitly selected mode authoritative over legacy effort', () => {
    const lock = buildConfigLock({
      ...base,
      executionMode: 'standard',
      reasoningEffort: 'ultra',
    });
    expect(lock.executionMode).toBe('standard');
    expect(lock.reasoningEffort).toBeNull();
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

  it('reports execution mode drift independently of reasoning effort', () => {
    const stored = buildConfigLock(base);
    const current = buildConfigLock({ ...base, executionMode: 'ultra' });
    expect(diffConfigLock(stored, current)).toEqual(['executionMode: standard → ultra']);
  });
});

describe('normalizeConfigLock', () => {
  it('upgrades a pre-241 lock that stored ultra as reasoning effort', () => {
    const legacy = { ...buildConfigLock(base), reasoningEffort: 'ultra' } as Record<string, unknown>;
    delete legacy.executionMode;

    const normalized = normalizeConfigLock(legacy);
    expect(normalized?.executionMode).toBe('ultra');
    expect(normalized?.reasoningEffort).toBeNull();
  });

  it('preserves a first-class mode when a malformed mixed lock is repaired', () => {
    const normalized = normalizeConfigLock({
      ...buildConfigLock(base),
      executionMode: 'standard',
      reasoningEffort: 'ultra',
    });
    expect(normalized?.executionMode).toBe('standard');
    expect(normalized?.reasoningEffort).toBeNull();
  });
});
