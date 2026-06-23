/**
 * Editor-level keymap (inside Monaco) per preset. The vscode preset IS
 * Monaco's default; the IntelliJ preset remaps the classics. Rules are
 * GLOBAL to the Monaco instance — applied once per preset, with
 * `command: null` rules unbinding the defaults that conflict.
 */
import type * as MonacoNs from 'monaco-editor';
import type { KeymapPreset } from '../../../keymap/keymap-store.js';

type Monaco = typeof MonacoNs;

let appliedPreset: KeymapPreset | null = null;

export function applyMonacoKeymap(monaco: Monaco, preset: KeymapPreset): void {
  if (appliedPreset === preset) return;
  appliedPreset = preset;
  if (preset !== 'intellij') {
    // Monaco defaults ≈ VS Code; nothing to do (rules from a previous
    // intellij application persist until reload — acceptable for a
    // preset switch, which the dialog flags as "reload recommended").
    return;
  }
  const K = monaco.KeyMod;
  const C = monaco.KeyCode;
  monaco.editor.addKeybindingRules([
    // Ctrl+D duplicates the line (IntelliJ), freeing it from
    // addSelectionToNextFindMatch (that stays on Ctrl+Shift+D here).
    { keybinding: K.CtrlCmd | C.KeyD, command: 'editor.action.copyLinesDownAction', when: 'editorTextFocus' },
    { keybinding: K.CtrlCmd | K.Shift | C.KeyD, command: 'editor.action.addSelectionToNextFindMatch', when: 'editorTextFocus' },
    // Ctrl+Y deletes the line (IntelliJ) instead of redo.
    { keybinding: K.CtrlCmd | C.KeyY, command: 'editor.action.deleteLines', when: 'editorTextFocus' },
    // Alt+Shift+↑/↓ moves lines (IntelliJ uses Ctrl+Shift+↑/↓ for "move
    // statement" — line-move is the closest editor primitive).
    { keybinding: K.Alt | K.Shift | C.UpArrow, command: 'editor.action.moveLinesUpAction', when: 'editorTextFocus' },
    { keybinding: K.Alt | K.Shift | C.DownArrow, command: 'editor.action.moveLinesDownAction', when: 'editorTextFocus' },
    // Ctrl+Alt+L reformat.
    { keybinding: K.CtrlCmd | K.Alt | C.KeyL, command: 'editor.action.formatDocument', when: 'editorTextFocus' },
    // Ctrl+W / Ctrl+Shift+W extend/shrink selection.
    { keybinding: K.CtrlCmd | C.KeyW, command: 'editor.action.smartSelect.expand', when: 'editorTextFocus' },
    { keybinding: K.CtrlCmd | K.Shift | C.KeyW, command: 'editor.action.smartSelect.shrink', when: 'editorTextFocus' },
    // Ctrl+B go to declaration; Alt+F7 find usages.
    { keybinding: K.CtrlCmd | C.KeyB, command: 'editor.action.revealDefinition', when: 'editorTextFocus' },
    { keybinding: K.Alt | C.F7, command: 'editor.action.goToReferences', when: 'editorTextFocus' },
    // Shift+F6 rename (F2 keeps working as the alias).
    { keybinding: K.Shift | C.F6, command: 'editor.action.rename', when: 'editorTextFocus' },
  ]);
}
