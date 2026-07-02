/**
 * C0 — PATCH-side validation + shallow merge for `config_json.autonomy`.
 * Unlike the resolve side (silently defensive), sanitize REJECTS known
 * fields with wrong types so a PATCH typo surfaces as a 400.
 */
import { describe, expect, it } from 'vitest';
import { mergeAutonomyPatch, sanitizeAutonomyPatch } from '../autonomy-patch.js';

describe('sanitizeAutonomyPatch', () => {
  it('rejects non-objects', () => {
    for (const bad of [null, 'x', 7, [], true]) {
      const r = sanitizeAutonomyPatch(bad);
      expect(r.ok).toBe(false);
    }
  });

  it('accepts a full valid patch and ignores unknown keys', () => {
    const r = sanitizeAutonomyPatch({
      scheduler: true,
      orphanReset: false,
      supervisorMaster: true,
      freeze: false,
      autoApproveRoles: [' dev ', 'qa', ''],
      maxSubordinates: 3,
      wipLimits: { in_progress: 2, bogus_column: 9 },
      totally_unknown: 'ignored',
    });
    expect(r).toEqual({
      ok: true,
      patch: {
        scheduler: true,
        orphanReset: false,
        supervisorMaster: true,
        freeze: false,
        autoApproveRoles: ['dev', 'qa'],
        maxSubordinates: 3,
        wipLimits: { in_progress: 2 }, // unknown column dropped silently
      },
    });
  });

  it('empty object → empty patch (no-op merge)', () => {
    expect(sanitizeAutonomyPatch({})).toEqual({ ok: true, patch: {} });
  });

  it('rejects wrongly-typed booleans', () => {
    const r = sanitizeAutonomyPatch({ scheduler: 'on' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('scheduler');
  });

  it("autoApproveRoles: accepts null / '*' / string[]; rejects mixed arrays", () => {
    expect(sanitizeAutonomyPatch({ autoApproveRoles: null }))
      .toEqual({ ok: true, patch: { autoApproveRoles: null } });
    expect(sanitizeAutonomyPatch({ autoApproveRoles: '*' }))
      .toEqual({ ok: true, patch: { autoApproveRoles: '*' } });
    expect(sanitizeAutonomyPatch({ autoApproveRoles: ['dev', 3] }).ok).toBe(false);
    expect(sanitizeAutonomyPatch({ autoApproveRoles: 'dev' }).ok).toBe(false);
  });

  it('maxSubordinates: int>0 or null; rejects 0, negatives, floats, strings', () => {
    expect(sanitizeAutonomyPatch({ maxSubordinates: 5 }))
      .toEqual({ ok: true, patch: { maxSubordinates: 5 } });
    expect(sanitizeAutonomyPatch({ maxSubordinates: null }))
      .toEqual({ ok: true, patch: { maxSubordinates: null } });
    for (const bad of [0, -1, 2.5, '3']) {
      expect(sanitizeAutonomyPatch({ maxSubordinates: bad }).ok).toBe(false);
    }
  });

  it('wipLimits: rejects non-objects and non-int>0 values on known columns', () => {
    expect(sanitizeAutonomyPatch({ wipLimits: [] }).ok).toBe(false);
    expect(sanitizeAutonomyPatch({ wipLimits: { todo: 0 } }).ok).toBe(false);
    expect(sanitizeAutonomyPatch({ wipLimits: { review: 'x' } }).ok).toBe(false);
  });
});

describe('mergeAutonomyPatch — shallow per-key merge', () => {
  it('patch keys override, untouched keys survive', () => {
    const merged = mergeAutonomyPatch(
      { scheduler: true, freeze: false, maxSubordinates: 4 },
      { freeze: true },
    );
    expect(merged).toEqual({ scheduler: true, freeze: true, maxSubordinates: 4 });
  });

  it('non-object previous value is treated as empty (corruption-safe)', () => {
    for (const prev of [undefined, null, 'junk', 42, []]) {
      expect(mergeAutonomyPatch(prev, { scheduler: true })).toEqual({ scheduler: true });
    }
  });

  it('wipLimits is replaced wholesale (merge is shallow by design)', () => {
    const merged = mergeAutonomyPatch(
      { wipLimits: { todo: 1, review: 2 } },
      { wipLimits: { in_progress: 3 } },
    );
    expect(merged).toEqual({ wipLimits: { in_progress: 3 } });
  });
});
