import { describe, expect, it } from 'vitest';
import {
  consumeSelectionPrefix,
  getSelected,
  getSelections,
  removeSelected,
  selectionKey,
  setSelected,
  toggleSelected,
  updateSelected,
  type SelectedElement,
} from '../studio-context-store.js';

/** Build a minimal `mcp:select` element; override only what a test cares about. */
function el(over: Partial<SelectedElement> = {}): SelectedElement {
  return {
    type: 'mcp:select',
    loc: '',
    componentName: null,
    tag: 'div',
    classes: [],
    text: '',
    rect: { x: 0, y: 0, width: 0, height: 0 },
    ...over,
  } as SelectedElement;
}

// Each test uses its own session id — the store is a module-level singleton.
let nextSid = 1;
const sid = () => nextSid++;

describe('selectionKey', () => {
  it('prefers loc, then selector, then tag|text', () => {
    expect(selectionKey(el({ loc: 'a.tsx:1:1', selector: 'div', tag: 'span', text: 'x' }))).toBe('a.tsx:1:1');
    expect(selectionKey(el({ loc: '', selector: 'main>div', tag: 'span', text: 'x' }))).toBe('main>div');
    expect(selectionKey(el({ loc: '', selector: '', tag: 'span', text: 'hi' }))).toBe('span|hi');
  });
});

describe('single-selection (plain click)', () => {
  it('setSelected replaces the whole set with one element', () => {
    const s = sid();
    setSelected(s, el({ loc: 'a.tsx:1:1' }));
    setSelected(s, el({ loc: 'b.tsx:2:2' }));
    expect(getSelections(s).map((e) => e.loc)).toEqual(['b.tsx:2:2']);
    expect(getSelected(s)?.loc).toBe('b.tsx:2:2');
  });

  it('setSelected(null) clears', () => {
    const s = sid();
    setSelected(s, el({ loc: 'a.tsx:1:1' }));
    setSelected(s, null);
    expect(getSelections(s)).toEqual([]);
    expect(getSelected(s)).toBeNull();
  });
});

describe('multi-selection (Ctrl/Cmd click)', () => {
  it('toggleSelected accumulates distinct elements and primary is the last', () => {
    const s = sid();
    toggleSelected(s, el({ loc: 'a.tsx:1:1' }));
    toggleSelected(s, el({ loc: 'b.tsx:2:2' }));
    toggleSelected(s, el({ loc: 'c.tsx:3:3' }));
    expect(getSelections(s).map((e) => e.loc)).toEqual(['a.tsx:1:1', 'b.tsx:2:2', 'c.tsx:3:3']);
    expect(getSelected(s)?.loc).toBe('c.tsx:3:3');
  });

  it('toggleSelected on the same key removes it (toggle off)', () => {
    const s = sid();
    toggleSelected(s, el({ loc: 'a.tsx:1:1' }));
    toggleSelected(s, el({ loc: 'b.tsx:2:2' }));
    toggleSelected(s, el({ loc: 'a.tsx:1:1' })); // same key → off
    expect(getSelections(s).map((e) => e.loc)).toEqual(['b.tsx:2:2']);
  });

  it('removeSelected drops only the matching key', () => {
    const s = sid();
    toggleSelected(s, el({ loc: 'a.tsx:1:1' }));
    toggleSelected(s, el({ loc: 'b.tsx:2:2' }));
    removeSelected(s, 'a.tsx:1:1');
    expect(getSelections(s).map((e) => e.loc)).toEqual(['b.tsx:2:2']);
  });
});

describe('updateSelected (visual-edit loc chase)', () => {
  it('patches the matched element without collapsing the set or reordering it', () => {
    const s = sid();
    toggleSelected(s, el({ loc: 'a.tsx:1:1' }));
    toggleSelected(s, el({ loc: 'b.tsx:2:2', classes: ['old'] }));
    toggleSelected(s, el({ loc: 'c.tsx:3:3' }));
    updateSelected(s, 'b.tsx:2:2', { loc: 'b.tsx:9:9', classes: ['new'] });
    expect(getSelections(s).map((e) => e.loc)).toEqual(['a.tsx:1:1', 'b.tsx:9:9', 'c.tsx:3:3']);
    expect(getSelections(s)[1].classes).toEqual(['new']);
  });
});

describe('consumeSelectionPrefix', () => {
  it('concatenates one block per element and then clears', () => {
    const s = sid();
    toggleSelected(s, el({ loc: 'a.tsx:1:1', tag: 'button', text: 'One' }));
    toggleSelected(s, el({ loc: 'b.tsx:2:2', tag: 'a', text: 'Two' }));
    const prefix = consumeSelectionPrefix(s);
    expect(prefix.match(/<selected-element /g)).toHaveLength(2);
    expect(prefix).toContain('loc="a.tsx:1:1"');
    expect(prefix).toContain('loc="b.tsx:2:2"');
    expect(prefix).toContain('One');
    expect(prefix).toContain('Two');
    expect(getSelections(s)).toEqual([]); // consumed → cleared
  });

  it('returns empty string when nothing is selected', () => {
    expect(consumeSelectionPrefix(sid())).toBe('');
  });
});
