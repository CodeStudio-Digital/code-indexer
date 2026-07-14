/** Generate Monaco rules from the effective keymap catalogue. */
import type * as MonacoNs from 'monaco-editor';
import { COMMAND_CATALOG } from '../../../keymap/commands.js';
import { effectiveBindings, useKeymapStore } from '../../../keymap/keymap-store.js';

type Monaco = typeof MonacoNs;

const KEY_NAMES: Record<string, string> = {
  '-': 'US_MINUS', '=': 'US_EQUAL', '+': 'NumpadAdd', '[': 'US_OPEN_SQUARE_BRACKET',
  ']': 'US_CLOSE_SQUARE_BRACKET', ';': 'US_SEMICOLON', "'": 'US_QUOTE',
  '`': 'US_BACKTICK', '\\': 'US_BACKSLASH', ',': 'US_COMMA', '.': 'US_DOT',
  Space: 'Space', Enter: 'Enter', Esc: 'Escape', Tab: 'Tab', Backspace: 'Backspace',
  Delete: 'Delete', Home: 'Home', End: 'End', PageUp: 'PageUp', PageDown: 'PageDown',
  Up: 'UpArrow', Down: 'DownArrow', Left: 'LeftArrow', Right: 'RightArrow',
};

function keyNamesFor(token: string): string[] {
  if (token === '/') return ['Slash', 'ABNT_C1', 'NumpadDivide'];
  if (/^[A-Z]$/.test(token)) return [`Key${token}`];
  if (/^[0-9]$/.test(token)) return [`Digit${token}`];
  if (/^F([1-9]|1[0-2])$/.test(token)) return [token];
  return [KEY_NAMES[token] ?? token];
}

function parseChord(monaco: Monaco, chord: string): number[] {
  const raw = chord.split('+');
  const keyToken = raw[raw.length - 1] === '' ? '+' : raw.pop()!;
  const modifiers = raw.filter(Boolean);
  return keyNamesFor(keyToken).flatMap((keyName) => {
    const code = (monaco.KeyCode as unknown as Record<string, number>)[keyName];
    if (code === undefined) return [];
    let value = code;
    if (modifiers.includes('Ctrl')) value |= monaco.KeyMod.CtrlCmd;
    if (modifiers.includes('Alt')) value |= monaco.KeyMod.Alt;
    if (modifiers.includes('Shift')) value |= monaco.KeyMod.Shift;
    return [value];
  });
}

export function bindingToMonaco(monaco: Monaco, binding: string): number[] {
  if (binding === 'Shift Shift') return []; // handled by the global dispatcher
  const chords = binding.split(' ');
  const first = parseChord(monaco, chords[0]);
  if (chords.length === 1) return first;
  const second = parseChord(monaco, chords[1]);
  const keyChord = (monaco.KeyMod as unknown as { chord?: (first: number, second: number) => number }).chord
    ?? (monaco as unknown as { KeyChord?: (first: number, second: number) => number }).KeyChord;
  if (!keyChord) return [];
  return first.flatMap((a) => second.map((b) => keyChord(a, b)));
}

/**
 * Native bindings managed by our catalogue are explicitly suppressed first.
 * This is what makes an empty override actually disable a shortcut instead of
 * exposing Monaco's hidden default underneath it.
 */
export function buildManagedMonacoRules(monaco: Monaco): MonacoNs.editor.IKeybindingRule[] {
  const { preset, overrides } = useKeymapStore.getState();
  const rules: MonacoNs.editor.IKeybindingRule[] = [];
  const seenSuppressed = new Set<string>();
  for (const command of COMMAND_CATALOG) {
    if (!command.monacoCommand) continue;
    for (const binding of [...(command.defaultKeys?.intellij ?? []), ...(command.defaultKeys?.vscode ?? [])]) {
      for (const keybinding of bindingToMonaco(monaco, binding)) {
        const key = `${keybinding}|${command.context ?? ''}`;
        if (seenSuppressed.has(key)) continue;
        seenSuppressed.add(key);
        rules.push({ keybinding, command: null, when: command.context });
      }
    }
    for (const binding of effectiveBindings(command, preset, overrides)) {
      for (const keybinding of bindingToMonaco(monaco, binding)) {
        rules.push({ keybinding, command: command.monacoCommand, when: command.context });
      }
    }
  }
  return rules;
}

let rulesDisposable: MonacoNs.IDisposable | null = null;
let watching = false;

export function applyMonacoKeymap(monaco: Monaco): void {
  rulesDisposable?.dispose();
  rulesDisposable = monaco.editor.addKeybindingRules(buildManagedMonacoRules(monaco));
}

export function watchKeymapPreset(monaco: Monaco): void {
  if (watching) return;
  watching = true;
  useKeymapStore.subscribe(() => applyMonacoKeymap(monaco));
}
