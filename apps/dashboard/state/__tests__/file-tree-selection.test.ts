/**
 * Pure-logic tests for the Explorer selection store + dropNested helper.
 * No DOM, no transport.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../lib/api-client.js', () => ({ apiCall: vi.fn() }));

import { useSelectionStore } from '../file-tree-selection.js';
import { dropNested } from '../../features/workspace/file-tree/delete-selection.js';

const ORDER = ['a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts'];

function reset(): void {
  useSelectionStore.setState({ projectId: 1, selected: new Set(), anchor: null, lead: null, version: 0 });
}

describe('selection store', () => {
  beforeEach(reset);

  it('setSingle replaces the selection and sets anchor/lead', () => {
    const s = useSelectionStore.getState();
    s.setSingle('b.ts');
    const st = useSelectionStore.getState();
    expect([...st.selected]).toEqual(['b.ts']);
    expect(st.anchor).toBe('b.ts');
    expect(st.lead).toBe('b.ts');
  });

  it('toggle adds then removes membership', () => {
    const s = useSelectionStore.getState();
    s.setSingle('a.ts');
    s.toggle('c.ts');
    expect([...useSelectionStore.getState().selected].sort()).toEqual(['a.ts', 'c.ts']);
    useSelectionStore.getState().toggle('c.ts');
    expect([...useSelectionStore.getState().selected]).toEqual(['a.ts']);
  });

  it('selectRange spans anchor..path over the visible order (both directions)', () => {
    const s = useSelectionStore.getState();
    s.setSingle('b.ts'); // anchor=b
    s.selectRange('d.ts', ORDER);
    expect([...useSelectionStore.getState().selected]).toEqual(['b.ts', 'c.ts', 'd.ts']);
    // Shift up from the same anchor re-computes the range (anchor stays b).
    useSelectionStore.getState().selectRange('a.ts', ORDER);
    expect([...useSelectionStore.getState().selected]).toEqual(['a.ts', 'b.ts']);
  });

  it('selectRange falls back to single when the anchor is out of order', () => {
    const s = useSelectionStore.getState();
    s.setSingle('zzz.ts'); // not in ORDER
    s.selectRange('c.ts', ORDER);
    expect([...useSelectionStore.getState().selected]).toEqual(['c.ts']);
  });

  it('prune removes a path and all its descendants', () => {
    useSelectionStore.setState({
      projectId: 1,
      selected: new Set(['src', 'src/a.ts', 'src/sub/b.ts', 'other.ts']),
      anchor: 'src/a.ts',
      lead: 'src/a.ts',
      version: 0,
    });
    useSelectionStore.getState().prune(['src']);
    expect([...useSelectionStore.getState().selected]).toEqual(['other.ts']);
    // anchor/lead pointed into the pruned subtree → cleared.
    expect(useSelectionStore.getState().anchor).toBeNull();
    expect(useSelectionStore.getState().lead).toBeNull();
  });

  it('init resets only on a different project', () => {
    const s = useSelectionStore.getState();
    s.setSingle('a.ts');
    s.init(1); // same project → no reset
    expect(useSelectionStore.getState().selected.size).toBe(1);
    useSelectionStore.getState().init(2); // different → reset
    expect(useSelectionStore.getState().selected.size).toBe(0);
    expect(useSelectionStore.getState().projectId).toBe(2);
  });
});

describe('dropNested', () => {
  it('keeps only top-most paths', () => {
    expect(dropNested(['src', 'src/a.ts', 'src/sub', 'src/sub/b.ts', 'pkg/x.ts']).sort()).toEqual(
      ['pkg/x.ts', 'src'].sort(),
    );
  });
  it('is a no-op when nothing nests', () => {
    expect(dropNested(['a.ts', 'b.ts']).sort()).toEqual(['a.ts', 'b.ts']);
  });
  it('does not treat sibling prefixes as nested (src vs src2)', () => {
    expect(dropNested(['src', 'src2/x.ts']).sort()).toEqual(['src', 'src2/x.ts'].sort());
  });
});
