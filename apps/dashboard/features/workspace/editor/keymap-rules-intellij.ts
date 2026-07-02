/**
 * Declarative IntelliJ-preset keybinding rules for Monaco. The data table
 * (INTELLIJ_RULES) is pure and unit-testable; buildIntellijRules resolves
 * the symbolic key names against the RUNTIME monaco.KeyCode enum — unknown
 * names are skipped (a Monaco build may drop a code) instead of crashing.
 *
 * Comment toggles bind THREE physical keys: Monaco resolves keybindings by
 * keyCode (US layout), so on ABNT2 keyboards the slash key is ABNT_C1 —
 * a plain `Ctrl+Slash` rule never fires there.
 */
import type * as MonacoNs from 'monaco-editor';

type Monaco = typeof MonacoNs;

export interface IntellijRuleSpec {
  /** Modifier set; Ctrl maps to CtrlCmd (Cmd on macOS). */
  mods: ReadonlyArray<'Ctrl' | 'Shift' | 'Alt'>;
  /** Property name on monaco.KeyCode, e.g. 'KeyD', 'Slash', 'ABNT_C1'. */
  key: string;
  /** Monaco action/command id; null unbinds the default on that chord. */
  command: string | null;
  when?: string;
}

const FOCUS = 'editorTextFocus';
const SLASH_KEYS = ['Slash', 'ABNT_C1', 'NumpadDivide'] as const;

const commentRules: IntellijRuleSpec[] = SLASH_KEYS.flatMap((key) => [
  { mods: ['Ctrl'] as const, key, command: 'editor.action.commentLine', when: FOCUS },
  { mods: ['Ctrl', 'Shift'] as const, key, command: 'editor.action.blockComment', when: FOCUS },
]);

export const INTELLIJ_RULES: readonly IntellijRuleSpec[] = [
  // ── line editing ─────────────────────────────────────────────────────
  { mods: ['Ctrl'], key: 'KeyD', command: 'editor.action.copyLinesDownAction', when: FOCUS },
  { mods: ['Ctrl', 'Shift'], key: 'KeyD', command: 'editor.action.addSelectionToNextFindMatch', when: FOCUS },
  { mods: ['Ctrl'], key: 'KeyY', command: 'editor.action.deleteLines', when: FOCUS },
  { mods: ['Alt', 'Shift'], key: 'UpArrow', command: 'editor.action.moveLinesUpAction', when: FOCUS },
  { mods: ['Alt', 'Shift'], key: 'DownArrow', command: 'editor.action.moveLinesDownAction', when: FOCUS },
  // IntelliJ "move statement" — line move is the closest editor primitive.
  { mods: ['Ctrl', 'Shift'], key: 'UpArrow', command: 'editor.action.moveLinesUpAction', when: FOCUS },
  { mods: ['Ctrl', 'Shift'], key: 'DownArrow', command: 'editor.action.moveLinesDownAction', when: FOCUS },
  { mods: ['Ctrl', 'Shift'], key: 'KeyJ', command: 'editor.action.joinLines', when: FOCUS },
  ...commentRules,
  // ── selection ────────────────────────────────────────────────────────
  { mods: ['Ctrl'], key: 'KeyW', command: 'editor.action.smartSelect.expand', when: FOCUS },
  { mods: ['Ctrl', 'Shift'], key: 'KeyW', command: 'editor.action.smartSelect.shrink', when: FOCUS },
  { mods: ['Alt'], key: 'KeyJ', command: 'editor.action.addSelectionToNextFindMatch', when: FOCUS },
  { mods: ['Alt', 'Shift'], key: 'KeyJ', command: 'cursorUndo', when: FOCUS },
  // ── navigation ───────────────────────────────────────────────────────
  { mods: ['Ctrl'], key: 'KeyB', command: 'editor.action.revealDefinition', when: FOCUS },
  { mods: ['Ctrl', 'Alt'], key: 'KeyB', command: 'editor.action.goToImplementation', when: FOCUS },
  { mods: ['Alt'], key: 'F7', command: 'editor.action.goToReferences', when: FOCUS },
  { mods: ['Ctrl', 'Shift'], key: 'F7', command: 'editor.action.wordHighlight.trigger', when: FOCUS },
  // F2 becomes next-error (IntelliJ); rename lives on Shift+F6 only.
  { mods: [], key: 'F2', command: null },
  { mods: [], key: 'F2', command: 'editor.action.marker.next', when: FOCUS },
  { mods: ['Shift'], key: 'F2', command: 'editor.action.marker.prev', when: FOCUS },
  // ── intentions / info ────────────────────────────────────────────────
  { mods: ['Alt'], key: 'Enter', command: 'editor.action.quickFix', when: FOCUS },
  { mods: ['Ctrl'], key: 'KeyP', command: 'editor.action.triggerParameterHints', when: FOCUS },
  { mods: ['Ctrl'], key: 'KeyQ', command: 'editor.action.showHover', when: FOCUS },
  // ── rename / format ──────────────────────────────────────────────────
  { mods: ['Shift'], key: 'F6', command: 'editor.action.rename', when: FOCUS },
  { mods: ['Ctrl', 'Alt'], key: 'KeyL', command: 'editor.action.formatSelection', when: 'editorTextFocus && editorHasSelection' },
  { mods: ['Ctrl', 'Alt'], key: 'KeyL', command: 'editor.action.formatDocument', when: 'editorTextFocus && !editorHasSelection' },
  // ── folding ──────────────────────────────────────────────────────────
  { mods: ['Ctrl'], key: 'NumpadSubtract', command: 'editor.fold', when: FOCUS },
  { mods: ['Ctrl'], key: 'NumpadAdd', command: 'editor.unfold', when: FOCUS },
  { mods: ['Ctrl', 'Shift'], key: 'NumpadSubtract', command: 'editor.foldAll', when: FOCUS },
  { mods: ['Ctrl', 'Shift'], key: 'NumpadAdd', command: 'editor.unfoldAll', when: FOCUS },
];

export function buildIntellijRules(monaco: Monaco): MonacoNs.editor.IKeybindingRule[] {
  const K = monaco.KeyMod;
  const codes = monaco.KeyCode as unknown as Record<string, number>;
  const rules: MonacoNs.editor.IKeybindingRule[] = [];
  for (const spec of INTELLIJ_RULES) {
    const code = codes[spec.key];
    if (typeof code !== 'number') continue;
    let keybinding = code;
    if (spec.mods.includes('Ctrl')) keybinding |= K.CtrlCmd;
    if (spec.mods.includes('Shift')) keybinding |= K.Shift;
    if (spec.mods.includes('Alt')) keybinding |= K.Alt;
    rules.push({ keybinding, command: spec.command, when: spec.when });
  }
  return rules;
}
