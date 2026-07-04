import { describe, it, expect } from 'vitest';
import { createPaneSelection } from '../pane-selection.js';

describe('createPaneSelection', () => {
  it('setSingle selects one and anchors it', () => {
    const s = createPaneSelection();
    s.getState().setSingle('a');
    expect([...s.getState().selected]).toEqual(['a']);
    expect(s.getState().anchor).toBe('a');
  });

  it('toggle adds then removes', () => {
    const s = createPaneSelection();
    s.getState().toggle('a');
    s.getState().toggle('b');
    expect(s.getState().selected).toEqual(new Set(['a', 'b']));
    s.getState().toggle('a');
    expect(s.getState().selected).toEqual(new Set(['b']));
  });

  it('selectRange spans anchor..target over the visible order', () => {
    const s = createPaneSelection();
    s.getState().setSingle('b');
    s.getState().selectRange('d', ['a', 'b', 'c', 'd']);
    expect(s.getState().selected).toEqual(new Set(['b', 'c', 'd']));
  });

  it('selectRange falls back to single when the anchor left the order', () => {
    const s = createPaneSelection();
    s.getState().setSingle('gone');
    s.getState().selectRange('c', ['a', 'b', 'c']);
    expect(s.getState().selected).toEqual(new Set(['c']));
  });

  it('prune drops a path and its descendants', () => {
    const s = createPaneSelection();
    s.getState().toggle('dir');
    s.getState().toggle('dir/child');
    s.getState().toggle('other');
    s.getState().prune(['dir']);
    expect(s.getState().selected).toEqual(new Set(['other']));
  });

  it('two stores are independent', () => {
    const a = createPaneSelection();
    const b = createPaneSelection();
    a.getState().setSingle('x');
    expect([...a.getState().selected]).toEqual(['x']);
    expect([...b.getState().selected]).toEqual([]);
  });
});
