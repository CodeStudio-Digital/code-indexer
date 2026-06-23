import { describe, it, expect } from 'vitest';
import { selectArchivable } from '../gc.js';
import { DEFAULT_CONSOLIDATOR_OPTIONS, type ConsolSnapshot } from '../types.js';

const NOW = Date.parse('2026-06-13T00:00:00Z');
const OLD = '2026-01-01 00:00:00'; // ~163 days before NOW
const RECENT = '2026-06-12 00:00:00';

function snap(id: number, over: Partial<ConsolSnapshot> = {}): ConsolSnapshot {
  return {
    id, category: 'note', title: `t${id}`, content: `c${id}`,
    importance: 0.2, access_count: 0, last_accessed_at: OLD, created_at: OLD, ...over,
  };
}

const staleAll = (id: number, total = 1) => new Map([[id, { stale: Array(total).fill('f'), total }]]);

describe('selectArchivable', () => {
  it('archives a fully-stale, cold, low-importance row', () => {
    const out = selectArchivable([snap(1)], staleAll(1), DEFAULT_CONSOLIDATOR_OPTIONS, NOW);
    expect(out).toEqual([{ id: 1, reason: 'stale+cold+low-importance' }]);
  });

  it('skips when not fully stale', () => {
    const partial = new Map([[1, { stale: ['f'], total: 2 }]]);
    expect(selectArchivable([snap(1)], partial, DEFAULT_CONSOLIDATOR_OPTIONS, NOW)).toEqual([]);
  });

  it('skips when importance is at/above the ceiling', () => {
    expect(selectArchivable([snap(1, { importance: 0.5 })], staleAll(1), DEFAULT_CONSOLIDATOR_OPTIONS, NOW)).toEqual([]);
  });

  it('skips when recently accessed (not cold)', () => {
    expect(selectArchivable([snap(1, { last_accessed_at: RECENT })], staleAll(1), DEFAULT_CONSOLIDATOR_OPTIONS, NOW)).toEqual([]);
  });

  it('skips when accessed more than the access ceiling', () => {
    expect(selectArchivable([snap(1, { access_count: 5 })], staleAll(1), DEFAULT_CONSOLIDATOR_OPTIONS, NOW)).toEqual([]);
  });

  it('never archives a row with no referenced files (cannot assess staleness)', () => {
    expect(selectArchivable([snap(1)], new Map(), DEFAULT_CONSOLIDATOR_OPTIONS, NOW)).toEqual([]);
  });
});
