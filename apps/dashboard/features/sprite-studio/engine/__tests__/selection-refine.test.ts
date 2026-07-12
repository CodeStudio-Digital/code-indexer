import { describe, expect, it } from 'vitest';
import { SelectionMask } from '../selection-mask.js';

describe('selection refinement', () => {
  it('grows, contracts and inverts a binary selection', () => {
    const selection = new SelectionMask(3, 3);
    selection.setRect({ x: 1, y: 1, w: 1, h: 1 }, 'replace');
    selection.resizeBy(1);
    expect([...selection.data!].filter(Boolean)).toHaveLength(5);
    selection.resizeBy(-1);
    expect([...selection.data!].filter(Boolean)).toHaveLength(1);
    selection.invert();
    expect([...selection.data!].filter(Boolean)).toHaveLength(8);
  });

  it('fills enclosed holes and removes small islands', () => {
    const selection = new SelectionMask(5, 5);
    selection.setRect({ x: 1, y: 1, w: 3, h: 3 }, 'replace');
    const hole = new Uint8Array(selection.data!); hole[12] = 0; selection.restore(hole);
    selection.fillHoles(); expect(selection.data![12]).toBe(1);
    const withIsland = new Uint8Array(selection.data!); withIsland[0] = 1; selection.restore(withIsland);
    selection.removeSmallIslands(2); expect(selection.data![0]).toBe(0);
  });
});
