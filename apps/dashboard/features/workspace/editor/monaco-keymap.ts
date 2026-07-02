/**
 * Editor-level keymap (inside Monaco) per preset. The vscode preset IS
 * Monaco's default; the IntelliJ preset remaps the classics via
 * addKeybindingRules. The returned IDisposable lets a preset switch
 * un-apply the rules live — no reload needed.
 */
import type * as MonacoNs from 'monaco-editor';
import { useKeymapStore, type KeymapPreset } from '../../../keymap/keymap-store.js';
import { buildIntellijRules } from './keymap-rules-intellij.js';

type Monaco = typeof MonacoNs;

let appliedPreset: KeymapPreset | null = null;
let rulesDisposable: MonacoNs.IDisposable | null = null;
let watching = false;

export function applyMonacoKeymap(monaco: Monaco, preset: KeymapPreset): void {
  if (appliedPreset === preset) return;
  appliedPreset = preset;
  rulesDisposable?.dispose();
  rulesDisposable = null;
  if (preset !== 'intellij') return; // Monaco defaults ≈ VS Code
  rulesDisposable = monaco.editor.addKeybindingRules(buildIntellijRules(monaco));
}

/**
 * Re-apply the Monaco rules when the preset changes in the keymap store.
 * Module-level singleton: MonacoMount calls this per editor mount, but the
 * subscription (like the rules themselves) is global to the Monaco instance.
 */
export function watchKeymapPreset(monaco: Monaco): void {
  if (watching) return;
  watching = true;
  useKeymapStore.subscribe((s) => applyMonacoKeymap(monaco, s.preset));
}
