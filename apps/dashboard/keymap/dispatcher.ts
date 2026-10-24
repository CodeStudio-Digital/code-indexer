/**
 * Global keymap dispatcher — ONE capture-phase keydown listener resolves
 * chords against the registry and executes commands.
 *
 *  - Tokens come from `e.code` (layout-immune: ABNT2 included).
 *  - Mouse3+ tokens use the physical button numbering users see on mice;
 *    primary/secondary clicks remain regular UI input and are never bindings.
 *  - Double-Shift ('Shift Shift') is detected on keyup: two PURE Shift
 *    taps within 350ms with no other key in between.
 *  - Two-chord bindings ('Ctrl+K Ctrl+S') arm a 1.2s pending state,
 *    surfaced via `onChordPending` for a status-bar indicator.
 *  - Inputs/textareas/contentEditable only receive commands that opt in
 *    via `allowInInputs`.
 */
import { getCommand, executeCommand } from './commands.js';
import { bindingIndex } from './keymap-store.js';
import { electronApi } from '../lib/api-client.js';

/** Browser tabs can't own Ctrl+W/N/T — preset entries gate on this. */
export const isDesktop = (): boolean => !!electronApi();

const CODE_KEYS: Record<string, string> = {
  Minus: '-', Equal: '=', BracketLeft: '[', BracketRight: ']',
  Semicolon: ';', Quote: "'", Backquote: '`', Backslash: '\\',
  Comma: ',', Period: '.', Slash: '/', Space: 'Space',
  // ABNT2's slash key + numpad divide — same '/' token as Slash, so one
  // 'Ctrl+/' binding covers every physical slash key.
  IntlRo: '/', NumpadDivide: '/',
  Enter: 'Enter', Escape: 'Esc', Tab: 'Tab', Backspace: 'Backspace',
  Delete: 'Delete', Home: 'Home', End: 'End', PageUp: 'PageUp', PageDown: 'PageDown',
  ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right',
  NumpadAdd: '+', NumpadSubtract: '-',
};

/** Normalize a keydown to a chord token, or null for bare modifiers. */
export function eventToChord(e: KeyboardEvent): string | null {
  const code = e.code;
  let key: string | null = null;
  if (/^Key[A-Z]$/.test(code)) key = code.slice(3);
  else if (/^Digit[0-9]$/.test(code)) key = code.slice(5);
  else if (/^F([1-9]|1[0-2])$/.test(code)) key = code;
  else if (code in CODE_KEYS) key = CODE_KEYS[code];
  if (!key) return null;
  const mods: string[] = [];
  if (e.ctrlKey || e.metaKey) mods.push('Ctrl'); // Cmd ≡ Ctrl in our maps
  if (e.altKey) mods.push('Alt');
  if (e.shiftKey) mods.push('Shift');
  return [...mods, key].join('+');
}

function eventModifiers(e: Pick<MouseEvent, 'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey'>): string[] {
  const mods: string[] = [];
  if (e.ctrlKey || e.metaKey) mods.push('Ctrl');
  if (e.altKey) mods.push('Alt');
  if (e.shiftKey) mods.push('Shift');
  return mods;
}

/** Normalize middle/back/forward/additional mouse buttons to Mouse3+. */
export function eventToMouseChord(e: MouseEvent): string | null {
  // DOM: 0=left, 1=middle, 2=right, 3=back, 4=forward, then extras.
  // UI numbering: left=1, right=2, middle=3, back=4, forward=5.
  const button = e.button === 1 ? 3 : e.button >= 3 ? e.button + 1 : null;
  if (button === null) return null;
  return [...eventModifiers(e), `Mouse${button}`].join('+');
}

function inEditable(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  const tag = el?.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || !!el?.isContentEditable;
}

type PendingListener = (prefix: string | null) => void;
const pendingListeners = new Set<PendingListener>();
function onChordPending(fn: PendingListener): () => void {
  pendingListeners.add(fn);
  return () => pendingListeners.delete(fn);
}

let installed = false;
let captureDepth = 0;

/** Temporarily keep the dispatcher from executing shortcuts while one is recorded. */
export function suspendKeymapDispatcher(): () => void {
  captureDepth += 1;
  let resumed = false;
  return () => {
    if (resumed) return;
    resumed = true;
    captureDepth = Math.max(0, captureDepth - 1);
  };
}

export function installKeymapDispatcher(): () => void {
  if (installed) return () => undefined;
  installed = true;

  let pendingPrefix: string | null = null;
  let pendingTimer: ReturnType<typeof setTimeout> | null = null;
  // Double-Shift tracking.
  let lastShiftUpAt = 0;
  let shiftTapPure = false;
  const consumedMouseButtons = new Set<number>();
  const mouseReleaseTimers = new Map<number, ReturnType<typeof setTimeout>>();

  let pendingExactId: string | null = null;

  const setPending = (prefix: string | null, exactId: string | null = null): void => {
    pendingPrefix = prefix;
    pendingExactId = exactId;
    if (pendingTimer) { clearTimeout(pendingTimer); pendingTimer = null; }
    if (prefix) {
      pendingTimer = setTimeout(() => {
        const fallback = pendingExactId;
        setPending(null);
        if (fallback) void executeCommand(fallback);
      }, 1200);
    }
    for (const fn of pendingListeners) {
      try { fn(prefix); } catch { /* ignore */ }
    }
  };

  const tryExecute = (sequence: string, e: KeyboardEvent | MouseEvent): boolean => {
    const index = bindingIndex();
    const ids = index.get(sequence);
    const isPrefix = [...index.keys()].some((key) => key.startsWith(`${sequence} `));
    if (ids) {
      for (const id of ids) {
        const cmd = getCommand(id);
        if (!cmd) continue;
        if (inEditable(e.target) && !cmd.allowInInputs) continue;
        if (!cmd.available || (cmd.handler?.when && !cmd.handler.when())) continue;
        e.preventDefault();
        e.stopPropagation();
        if (isPrefix) setPending(sequence, id);
        else {
          setPending(null);
          void executeCommand(id);
        }
        return true;
      }
    }
    // Prefix of a two-chord binding?
    if (isPrefix) {
      e.preventDefault();
      e.stopPropagation();
      setPending(sequence);
      return true;
    }
    return false;
  };

  const dispatchChord = (chord: string, e: KeyboardEvent | MouseEvent): boolean => {
    if (pendingPrefix) {
      const seq = `${pendingPrefix} ${chord}`;
      const fired = tryExecute(seq, e);
      if (!fired) {
        const fallback = pendingExactId;
        setPending(null);
        if (fallback) void executeCommand(fallback);
      }
      return fired;
    }
    return tryExecute(chord, e);
  };

  const isReservedSequence = (sequence: string): boolean => {
    const index = bindingIndex();
    return index.has(sequence) || [...index.keys()].some((key) => key.startsWith(`${sequence} `));
  };

  const onKeyDown = (e: KeyboardEvent): void => {
    if (captureDepth > 0) return;
    if (e.isComposing) return;
    // Track double-Shift purity: any non-Shift key between taps cancels.
    if (e.code === 'ShiftLeft' || e.code === 'ShiftRight') {
      shiftTapPure = !(e.ctrlKey || e.metaKey || e.altKey);
      return;
    }
    shiftTapPure = false;

    const chord = eventToChord(e);
    if (!chord) return;

    dispatchChord(chord, e);
  };

  const onKeyUp = (e: KeyboardEvent): void => {
    if (captureDepth > 0) return;
    if (e.code !== 'ShiftLeft' && e.code !== 'ShiftRight') return;
    if (!shiftTapPure) { lastShiftUpAt = 0; return; }
    const now = Date.now();
    if (now - lastShiftUpAt < 350) {
      lastShiftUpAt = 0;
      if (!inEditable(e.target)) {
        const index = bindingIndex();
        const ids = index.get('Shift Shift');
        if (ids?.length) {
          e.preventDefault();
          void executeCommand(ids[0]);
        }
      }
    } else {
      lastShiftUpAt = now;
    }
  };

  const onMouseDown = (e: MouseEvent): void => {
    if (captureDepth > 0) return;
    const chord = eventToMouseChord(e);
    if (!chord) return;
    const sequence = pendingPrefix ? `${pendingPrefix} ${chord}` : chord;
    const reserved = isReservedSequence(sequence);
    dispatchChord(chord, e);
    // A configured mouse gesture owns the button even when its command's
    // context is currently inactive. Otherwise Chromium may navigate back.
    if (reserved) {
      e.preventDefault();
      e.stopPropagation();
      consumedMouseButtons.add(e.button);
      const timer = mouseReleaseTimers.get(e.button);
      if (timer) clearTimeout(timer);
      mouseReleaseTimers.delete(e.button);
    }
  };

  const suppressConsumedMouseEvent = (e: MouseEvent): void => {
    if (!consumedMouseButtons.has(e.button)) return;
    e.preventDefault();
    e.stopPropagation();
    if (e.type === 'auxclick') {
      consumedMouseButtons.delete(e.button);
      const timer = mouseReleaseTimers.get(e.button);
      if (timer) clearTimeout(timer);
      mouseReleaseTimers.delete(e.button);
      return;
    }
    const previous = mouseReleaseTimers.get(e.button);
    if (previous) clearTimeout(previous);
    mouseReleaseTimers.set(e.button, setTimeout(() => {
      consumedMouseButtons.delete(e.button);
      mouseReleaseTimers.delete(e.button);
    }, 0));
  };

  window.addEventListener('keydown', onKeyDown, true);
  window.addEventListener('keyup', onKeyUp, true);
  window.addEventListener('mousedown', onMouseDown, true);
  window.addEventListener('mouseup', suppressConsumedMouseEvent, true);
  window.addEventListener('auxclick', suppressConsumedMouseEvent, true);
  return () => {
    installed = false;
    window.removeEventListener('keydown', onKeyDown, true);
    window.removeEventListener('keyup', onKeyUp, true);
    window.removeEventListener('mousedown', onMouseDown, true);
    window.removeEventListener('mouseup', suppressConsumedMouseEvent, true);
    window.removeEventListener('auxclick', suppressConsumedMouseEvent, true);
    for (const timer of mouseReleaseTimers.values()) clearTimeout(timer);
    mouseReleaseTimers.clear();
    consumedMouseButtons.clear();
  };
}
