/**
 * AI-completion commands + Monaco keybinding rules.
 *
 * Manual trigger (Alt+\) goes through the GLOBAL command registry (Search
 * Everywhere + keymap dialog + capture-phase dispatcher) and arms a
 * force-provide flag the inline provider consumes to bypass snooze/debounce.
 * Accept-next-line rides monaco.editor.addKeybindingRules on
 * Ctrl+Shift+Right — NOT Ctrl+Alt+Right, which the IntelliJ preset binds to
 * navigate.forward with allowInInputs (the window-level dispatcher fires
 * before Monaco and would swallow the chord). Ctrl+Right (accept word) is a
 * Monaco 0.52 built-in and needs nothing.
 */
import type * as MonacoNs from 'monaco-editor';
import { registerCommands } from '../../../keymap/commands.js';
import { getActiveEditor } from './editor-models.js';
import { useAiCompleteStore } from './inlineCompletionProvider.js';

type Monaco = typeof MonacoNs;

// Belt-and-suspenders beside InlineCompletionTriggerKind.Explicit: consumed
// by the provider's next provideInlineCompletions call.
let forceProvideArmed = false;

export function armForceProvide(): void {
  forceProvideArmed = true;
}

export function consumeForceProvide(): boolean {
  const armed = forceProvideArmed;
  forceProvideArmed = false;
  return armed;
}

export interface AiCompleteRuleSpec {
  mods: ReadonlyArray<'Ctrl' | 'Shift' | 'Alt'>;
  /** Property name on monaco.KeyCode. */
  key: string;
  command: string;
  when: string;
}

/** Preset-independent rules (applied once, alongside whichever preset). */
export const AI_COMPLETE_RULES: readonly AiCompleteRuleSpec[] = [
  {
    mods: ['Ctrl', 'Shift'],
    key: 'RightArrow',
    command: 'editor.action.inlineSuggest.acceptNextLine',
    when: 'inlineSuggestionVisible && editorTextFocus',
  },
];

/** Resolve symbolic specs against the runtime enums (unknown keys skip). */
export function buildAiCompleteRules(monaco: Monaco): MonacoNs.editor.IKeybindingRule[] {
  const out: MonacoNs.editor.IKeybindingRule[] = [];
  for (const spec of AI_COMPLETE_RULES) {
    const keyCode = (monaco.KeyCode as unknown as Record<string, number>)[spec.key];
    if (keyCode === undefined) continue;
    let binding = keyCode;
    for (const mod of spec.mods) {
      if (mod === 'Ctrl') binding |= monaco.KeyMod.CtrlCmd;
      else if (mod === 'Shift') binding |= monaco.KeyMod.Shift;
      else binding |= monaco.KeyMod.Alt;
    }
    out.push({ keybinding: binding, command: spec.command, when: spec.when });
  }
  return out;
}

export function registerAiCompleteCommands(): () => void {
  return registerCommands([
    {
      id: 'editor.aiComplete.triggerSuggest',
      title: 'Trigger AI Completion',
      category: 'Editor',
      defaultKeys: { intellij: 'Alt+\\', vscode: 'Alt+\\' },
      allowInInputs: true,
      run: () => {
        const store = useAiCompleteStore.getState();
        if (!store.enabled) {
          // Explicit intent while OFF gets feedback, never silence: the chip
          // nudge explains how to enable (or that no model is bound).
          store.requestNudge('enable-hint');
          return;
        }
        const editor = getActiveEditor();
        if (!editor) return;
        armForceProvide();
        editor.focus();
        editor.trigger('keymap', 'editor.action.inlineSuggest.trigger', null);
      },
    },
    {
      id: 'editor.aiComplete.toggle',
      title: 'Toggle AI Completion',
      category: 'Editor',
      // Unbound by default — discoverable in Search Everywhere / keymap dialog.
      run: () => {
        const store = useAiCompleteStore.getState();
        store.setEnabled(!store.enabled);
      },
    },
  ]);
}
