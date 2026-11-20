/**
 * The golden must survive a rerun over a freshly built fixture: each
 * database draws its own revision generation, but the revision counter, and
 * everything else, still has to match. No database is opened here.
 */
import { describe, expect, it } from 'vitest';
import { goldenForm } from './index-tools-golden/compare.js';

const result = (revision: string, after = revision) => ({
  content: 'Found 3 matches',
  structuredData: { hits: [], freshness: { mode: 'live_disk', structuralRevision: revision, snapshot: false } },
  diagnostics: { structuralRevision: revision, structuralRevisionAfter: after },
});

describe('golden form of a structural revision', () => {
  it('ignores the per-database generation and keeps the counter', () => {
    const one = result('17DBD6BDDE7E6AB17B9BF0EA14FDE5CC:35');
    const two = result('3836D3D68554EA93214CCEDE7AB25023:35');
    expect(goldenForm(one)).toEqual(goldenForm(two));
    expect(JSON.stringify(goldenForm(one))).toContain('<generation>:35');
  });

  it('still tells different counters apart', () => {
    expect(goldenForm(result('17DBD6BDDE7E6AB17B9BF0EA14FDE5CC:35')))
      .not.toEqual(goldenForm(result('17DBD6BDDE7E6AB17B9BF0EA14FDE5CC:36')));
    expect(goldenForm(result('17DBD6BDDE7E6AB17B9BF0EA14FDE5CC:35', '3836D3D68554EA93214CCEDE7AB25023:5')))
      .not.toEqual(goldenForm(result('17DBD6BDDE7E6AB17B9BF0EA14FDE5CC:35')));
  });

  it('applies inside an overlay-wrapped source and leaves other values alone', () => {
    const wrapped = (revision: string) => ({ structuredData: { source: result(revision).structuredData, overlayApplied: true } });
    expect(goldenForm(wrapped('17DBD6BDDE7E6AB17B9BF0EA14FDE5CC:35')))
      .toEqual(goldenForm(wrapped('ABCDEF0123456789ABCDEF0123456789:35')));
    const hash = 'sha256:4d936efc9aa0b1691ed01463c1dd6a1cceedf9db916baf13dd6540edd3a578a1:67591';
    expect(goldenForm({ content: hash, structuralRevision: 'empty' })).toEqual({ content: hash, structuralRevision: 'empty' });
  });
});
