/**
 * Keyboard navigation rules for a file pane, as a PURE reducer.
 *
 * The panes had no keyboard support at all: no arrows, no Home/End, no
 * Ctrl+A (the store exposed `selectAll` and nothing ever called it), no
 * type-ahead, and the rows carried `role="option"` with no focusable
 * `role="listbox"` parent. Everything required a mouse.
 *
 * Kept free of React and of the store so the transitions are unit-testable —
 * the hook only translates the returned intent into store calls and side
 * effects.
 */

export type PaneKeyIntent =
  | { kind: 'none' }
  /** Move the cursor to `index`. `mode` decides what happens to the selection. */
  | { kind: 'move'; index: number; mode: 'select' | 'range' | 'lead' }
  | { kind: 'selectAll' }
  | { kind: 'open' }
  | { kind: 'parent' }
  | { kind: 'remove' }
  | { kind: 'rename' }
  | { kind: 'refresh' }
  | { kind: 'clear' };

export interface PaneKeyContext {
  /** Row count in the CURRENT (sorted) order. */
  count: number;
  /** Index of the cursor row, or -1 when there is none yet. */
  leadIndex: number;
  /** Rows that fit on screen — drives PageUp/PageDown. */
  pageSize: number;
}

export interface PaneKeyEvent {
  key: string;
  shiftKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
}

const clamp = (i: number, count: number): number => Math.min(count - 1, Math.max(0, i));

/**
 * Map a keydown to an intent. Returns `{kind:'none'}` for anything the pane
 * doesn't handle, so the caller knows not to preventDefault.
 */
export function paneKeyIntent(e: PaneKeyEvent, ctx: PaneKeyContext): PaneKeyIntent {
  const { count, leadIndex, pageSize } = ctx;
  const mod = e.ctrlKey || e.metaKey;

  if (mod && (e.key === 'a' || e.key === 'A')) return { kind: 'selectAll' };
  if (count === 0) return { kind: 'none' };

  // Ctrl+Arrow moves the cursor without disturbing the selection (IntelliJ /
  // Explorer behaviour); Shift extends; plain replaces.
  const mode = mod ? 'lead' : e.shiftKey ? 'range' : 'select';
  // From "no cursor", Down lands on the first row and Up on the last.
  const from = leadIndex < 0 ? -1 : leadIndex;
  const step = (delta: number): PaneKeyIntent => ({
    kind: 'move',
    index: from < 0 ? (delta > 0 ? 0 : count - 1) : clamp(from + delta, count),
    mode,
  });

  switch (e.key) {
    case 'ArrowDown':
      return step(1);
    case 'ArrowUp':
      return step(-1);
    case 'PageDown':
      return step(Math.max(1, pageSize));
    case 'PageUp':
      return step(-Math.max(1, pageSize));
    case 'Home':
      return { kind: 'move', index: 0, mode };
    case 'End':
      return { kind: 'move', index: count - 1, mode };
    case 'Enter':
      return leadIndex >= 0 ? { kind: 'open' } : { kind: 'none' };
    case 'Backspace':
      return { kind: 'parent' };
    case 'Delete':
      return { kind: 'remove' };
    case 'F2':
      return { kind: 'rename' };
    case 'F5':
      return { kind: 'refresh' };
    case 'Escape':
      return { kind: 'clear' };
    default:
      return { kind: 'none' };
  }
}

/** How long a type-ahead prefix stays alive between keystrokes. */
export const TYPEAHEAD_RESET_MS = 500;

export interface TypeaheadState {
  buffer: string;
  lastKeyAtMs: number;
}

/**
 * True for a key that should feed type-ahead: a single printable character with
 * no modifier. Space is excluded — it would be swallowed before it can ever act
 * as a selection toggle, and a leading space in a filename is vanishingly rare.
 */
export function isTypeaheadKey(e: PaneKeyEvent): boolean {
  return e.key.length === 1 && e.key !== ' ' && !e.ctrlKey && !e.metaKey && !e.altKey;
}

/**
 * Advance the type-ahead buffer and find the next match.
 *
 * Repeating the SAME character cycles through entries starting with it (what
 * every file manager does when you tap `s` repeatedly); anything else extends
 * the prefix. Search wraps, starting just after the cursor.
 */
export function typeaheadMatch(
  names: string[],
  state: TypeaheadState,
  key: string,
  nowMs: number,
  fromIndex: number,
): { state: TypeaheadState; index: number } {
  const expired = nowMs - state.lastKeyAtMs > TYPEAHEAD_RESET_MS;
  const prev = expired ? '' : state.buffer;
  const repeat = prev.length > 0 && prev.split('').every((c) => c === key);
  const buffer = expired ? key : repeat ? key : prev + key;
  const needle = buffer.toLowerCase();

  const start = fromIndex < 0 ? 0 : (fromIndex + (buffer.length === 1 ? 1 : 0)) % Math.max(1, names.length);
  for (let i = 0; i < names.length; i += 1) {
    const idx = (start + i) % names.length;
    if (names[idx].toLowerCase().startsWith(needle)) {
      return { state: { buffer, lastKeyAtMs: nowMs }, index: idx };
    }
  }
  return { state: { buffer, lastKeyAtMs: nowMs }, index: -1 };
}
