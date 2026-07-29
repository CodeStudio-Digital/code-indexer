/**
 * The panes had ZERO keyboard support: no arrows, no Home/End, no Ctrl+A (the
 * selection store exposed `selectAll` and nothing ever called it), no
 * type-ahead. These pin the transitions, which is where the fiddly cases live.
 */
import { describe, expect, it } from 'vitest';
import { isTypeaheadKey, paneKeyIntent, typeaheadMatch } from '../pane-keys.js';

const key = (k: string, mods: Partial<{ shiftKey: boolean; ctrlKey: boolean; metaKey: boolean; altKey: boolean }> = {}) => ({
  key: k,
  shiftKey: false,
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  ...mods,
});
const ctx = (over: Partial<{ count: number; leadIndex: number; pageSize: number }> = {}) => ({
  count: 10,
  leadIndex: 3,
  pageSize: 5,
  ...over,
});

describe('paneKeyIntent — navigation', () => {
  it('arrows move the cursor and replace the selection', () => {
    expect(paneKeyIntent(key('ArrowDown'), ctx())).toEqual({ kind: 'move', index: 4, mode: 'select' });
    expect(paneKeyIntent(key('ArrowUp'), ctx())).toEqual({ kind: 'move', index: 2, mode: 'select' });
  });

  it('Shift+Arrow extends the range instead', () => {
    expect(paneKeyIntent(key('ArrowDown', { shiftKey: true }), ctx())).toEqual({ kind: 'move', index: 4, mode: 'range' });
  });

  it('Ctrl+Arrow moves the cursor WITHOUT touching the selection', () => {
    expect(paneKeyIntent(key('ArrowDown', { ctrlKey: true }), ctx())).toEqual({ kind: 'move', index: 4, mode: 'lead' });
  });

  it('clamps at both ends instead of wrapping', () => {
    expect(paneKeyIntent(key('ArrowUp'), ctx({ leadIndex: 0 }))).toEqual({ kind: 'move', index: 0, mode: 'select' });
    expect(paneKeyIntent(key('ArrowDown'), ctx({ leadIndex: 9 }))).toEqual({ kind: 'move', index: 9, mode: 'select' });
  });

  it('with no cursor yet, Down lands on the first row and Up on the last', () => {
    expect(paneKeyIntent(key('ArrowDown'), ctx({ leadIndex: -1 }))).toEqual({ kind: 'move', index: 0, mode: 'select' });
    expect(paneKeyIntent(key('ArrowUp'), ctx({ leadIndex: -1 }))).toEqual({ kind: 'move', index: 9, mode: 'select' });
  });

  it('Home/End jump to the ends', () => {
    expect(paneKeyIntent(key('Home'), ctx())).toEqual({ kind: 'move', index: 0, mode: 'select' });
    expect(paneKeyIntent(key('End'), ctx())).toEqual({ kind: 'move', index: 9, mode: 'select' });
  });

  it('PageUp/PageDown move by a screenful, clamped', () => {
    expect(paneKeyIntent(key('PageDown'), ctx())).toEqual({ kind: 'move', index: 8, mode: 'select' });
    expect(paneKeyIntent(key('PageUp'), ctx())).toEqual({ kind: 'move', index: 0, mode: 'select' });
  });

  it('never divides by a zero page size', () => {
    expect(paneKeyIntent(key('PageDown'), ctx({ pageSize: 0 }))).toEqual({ kind: 'move', index: 4, mode: 'select' });
  });
});

describe('paneKeyIntent — actions', () => {
  it('maps the action keys', () => {
    expect(paneKeyIntent(key('Enter'), ctx()).kind).toBe('open');
    expect(paneKeyIntent(key('Backspace'), ctx()).kind).toBe('parent');
    expect(paneKeyIntent(key('Delete'), ctx()).kind).toBe('remove');
    expect(paneKeyIntent(key('F2'), ctx()).kind).toBe('rename');
    expect(paneKeyIntent(key('F5'), ctx()).kind).toBe('refresh');
    expect(paneKeyIntent(key('Escape'), ctx()).kind).toBe('clear');
  });

  it('Ctrl/Cmd+A selects all, and works even on an empty pane', () => {
    expect(paneKeyIntent(key('a', { ctrlKey: true }), ctx()).kind).toBe('selectAll');
    expect(paneKeyIntent(key('A', { metaKey: true }), ctx()).kind).toBe('selectAll');
    expect(paneKeyIntent(key('a', { ctrlKey: true }), ctx({ count: 0 })).kind).toBe('selectAll');
  });

  it('Enter with no cursor does nothing', () => {
    expect(paneKeyIntent(key('Enter'), ctx({ leadIndex: -1 })).kind).toBe('none');
  });

  it('an empty pane ignores navigation', () => {
    expect(paneKeyIntent(key('ArrowDown'), ctx({ count: 0 })).kind).toBe('none');
  });

  it('leaves unrelated keys alone so they can be typed / bubble', () => {
    expect(paneKeyIntent(key('x'), ctx()).kind).toBe('none');
    expect(paneKeyIntent(key('Tab'), ctx()).kind).toBe('none');
  });
});

describe('type-ahead', () => {
  const names = ['alpha.txt', 'apple.txt', 'beta.txt', 'Avocado.txt'];
  const fresh = { buffer: '', lastKeyAtMs: 0 };

  it('only claims plain printable keys', () => {
    expect(isTypeaheadKey(key('a'))).toBe(true);
    expect(isTypeaheadKey(key('a', { ctrlKey: true }))).toBe(false); // Ctrl+A must select-all
    expect(isTypeaheadKey(key(' '))).toBe(false);
    expect(isTypeaheadKey(key('ArrowDown'))).toBe(false);
  });

  it('jumps to the first match, case-insensitively', () => {
    expect(typeaheadMatch(names, fresh, 'b', 1000, -1).index).toBe(2);
    expect(typeaheadMatch(names, fresh, 'A', 1000, -1).index).toBe(0);
  });

  it('extends the prefix on a different key', () => {
    const first = typeaheadMatch(names, fresh, 'a', 1000, -1);
    const second = typeaheadMatch(names, first.state, 'p', 1010, first.index);
    expect(second.state.buffer).toBe('ap');
    expect(second.index).toBe(1); // apple.txt
  });

  it('repeating the SAME key cycles through matches instead of extending', () => {
    const first = typeaheadMatch(names, fresh, 'a', 1000, -1); // alpha (0)
    const second = typeaheadMatch(names, first.state, 'a', 1010, first.index); // apple (1)
    expect(second.state.buffer).toBe('a');
    expect(second.index).toBe(1);
    const third = typeaheadMatch(names, second.state, 'a', 1020, second.index); // Avocado (3)
    expect(third.index).toBe(3);
  });

  it('resets the prefix after the idle timeout', () => {
    const first = typeaheadMatch(names, fresh, 'a', 1000, -1);
    const late = typeaheadMatch(names, first.state, 'b', 5000, first.index);
    expect(late.state.buffer).toBe('b'); // not 'ab'
    expect(late.index).toBe(2);
  });

  it('reports -1 when nothing matches, without losing the buffer', () => {
    const res = typeaheadMatch(names, fresh, 'z', 1000, -1);
    expect(res.index).toBe(-1);
    expect(res.state.buffer).toBe('z');
  });

  it('handles an empty listing', () => {
    expect(typeaheadMatch([], fresh, 'a', 1000, -1).index).toBe(-1);
  });
});
