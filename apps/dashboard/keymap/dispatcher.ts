/**
 * Global keymap dispatcher — ONE capture-phase keydown listener resolves
 * chords against the registry and executes commands.
 *
 *  - Tokens come from `e.code` (layout-immune: ABNT2 included).
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

function inEditable(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  const tag = el?.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || !!el?.isContentEditable;
}

type PendingListener = (prefix: string | null) => void;
const pendingListeners = new Set<PendingListener>();
export function onChordPending(fn: PendingListener): () => void {
  pendingListeners.add(fn);
  return () => pendingListeners.delete(fn);
}

let installed = false;

export function installKeymapDispatcher(): () => void {
  if (installed) return () => undefined;
  installed = true;

  let pendingPrefix: string | null = null;
  let pendingTimer: ReturnType<typeof setTimeout> | null = null;
  // Double-Shift tracking.
  let lastShiftUpAt = 0;
  let shiftTapPure = false;

  const setPending = (prefix: string | null): void => {
    pendingPrefix = prefix;
    if (pendingTimer) { clearTimeout(pendingTimer); pendingTimer = null; }
    if (prefix) {
      pendingTimer = setTimeout(() => setPending(null), 1200);
    }
    for (const fn of pendingListeners) {
      try { fn(prefix); } catch { /* ignore */ }
    }
  };

  const tryExecute = (sequence: string, e: KeyboardEvent): boolean => {
    const index = bindingIndex();
    const ids = index.get(sequence);
    if (ids) {
      for (const id of ids) {
        const cmd = getCommand(id);
        if (!cmd) continue;
        if (inEditable(e.target) && !cmd.allowInInputs) continue;
        if (cmd.when && !cmd.when()) continue;
        e.preventDefault();
        e.stopPropagation();
        setPending(null);
        void executeCommand(id);
        return true;
      }
    }
    // Prefix of a two-chord binding?
    for (const key of index.keys()) {
      if (key.startsWith(`${sequence} `)) {
        e.preventDefault();
        e.stopPropagation();
        setPending(sequence);
        return true;
      }
    }
    return false;
  };

  const onKeyDown = (e: KeyboardEvent): void => {
    if (e.isComposing) return;
    // Track double-Shift purity: any non-Shift key between taps cancels.
    if (e.code === 'ShiftLeft' || e.code === 'ShiftRight') {
      shiftTapPure = !(e.ctrlKey || e.metaKey || e.altKey);
      return;
    }
    shiftTapPure = false;

    const chord = eventToChord(e);
    if (!chord) return;

    if (pendingPrefix) {
      const seq = `${pendingPrefix} ${chord}`;
      const fired = tryExecute(seq, e);
      if (!fired) setPending(null); // broken chord — swallow nothing further
      return;
    }
    tryExecute(chord, e);
  };

  const onKeyUp = (e: KeyboardEvent): void => {
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

  window.addEventListener('keydown', onKeyDown, true);
  window.addEventListener('keyup', onKeyUp, true);
  return () => {
    installed = false;
    window.removeEventListener('keydown', onKeyDown, true);
    window.removeEventListener('keyup', onKeyUp, true);
  };
}
