/**
 * scoring — the shared blend + diversity pass behind memory injection.
 * The category term is the product goal in miniature: a stated preference
 * must outrank a loose note at equal relevance.
 */
import { describe, expect, it } from 'vitest';
import { blendedMemoryScore, diversify, CATEGORY_WEIGHT, PIN_IMPORTANCE } from '../scoring.js';

const base = { relevance: 1, importance: 0.5, recency: 0.5, usage: 0.5, staleMult: 1 };

describe('blendedMemoryScore', () => {
  it('preference outranks note at identical signals', () => {
    expect(blendedMemoryScore({ ...base, type: 'preference' }))
      .toBeGreaterThan(blendedMemoryScore({ ...base, type: 'note' }));
  });

  it('unknown type gets the neutral default weight', () => {
    const unknown = blendedMemoryScore({ ...base, type: 'whatever' });
    const pattern = blendedMemoryScore({ ...base, type: 'pattern' }); // weight 0.5 too
    expect(unknown).toBeCloseTo(pattern, 10);
  });

  it('staleness multiplies the whole blend', () => {
    const fresh = blendedMemoryScore({ ...base, type: 'gotcha' });
    const stale = blendedMemoryScore({ ...base, type: 'gotcha', staleMult: 0.5 });
    expect(stale).toBeCloseTo(fresh * 0.5, 10);
  });

  it('weights table covers every closed agent-memory type', () => {
    for (const t of ['preference', 'convention', 'procedure', 'architecture', 'gotcha', 'external_pointer', 'pattern', 'decision', 'note']) {
      expect(CATEGORY_WEIGHT[t], t).toBeDefined();
    }
    expect(PIN_IMPORTANCE).toBe(0.9);
  });
});

describe('diversify', () => {
  const item = (id: number, type: string) => ({ id, type });

  it('caps same-type items in the head, keeps order, appends overflow', () => {
    const out = diversify([
      item(1, 'procedure'), item(2, 'procedure'), item(3, 'procedure'),
      item(4, 'convention'), item(5, 'note'),
    ]);
    expect(out.map((x) => x.id)).toEqual([1, 2, 4, 5, 3]); // 3rd procedure demoted past the others
  });

  it('no-op when types are already diverse', () => {
    const items = [item(1, 'a'), item(2, 'b'), item(3, 'c')];
    expect(diversify(items)).toEqual(items);
  });

  it('never drops items (a larger topK can still reach the overflow)', () => {
    const items = Array.from({ length: 6 }, (_, i) => item(i, 'note'));
    expect(diversify(items)).toHaveLength(6);
  });
});
