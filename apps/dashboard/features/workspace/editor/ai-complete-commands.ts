/**
 * AI-completion commands + Monaco keybinding rules.
 *
 * Manual trigger (Alt+\) goes through the GLOBAL command registry (Search
 * Everywhere + keymap dialog + capture-phase dispatcher) and arms a
 * force-provide flag the inline provider consumes to bypass snooze/debounce.
 * Accept-next-line is declared in the shared command catalogue, so it is
 * visible, remappable and applied by the same Monaco keymap generator as every
 * other managed action. Ctrl+Right (accept word) remains a Monaco built-in.
 */
import { registerCommandHandlers } from '../../../keymap/commands.js';
import { getActiveEditor } from './editor-models.js';
import { useAiCompleteStore } from './ai-complete-store.js';

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

export function registerAiCompleteCommands(): () => void {
  return registerCommandHandlers([
    {
      id: 'editor.aiComplete.triggerSuggest',
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
      run: () => {
        const store = useAiCompleteStore.getState();
        store.setEnabled(!store.enabled);
      },
    },
    {
      id: 'editor.aiComplete.acceptNextLine',
      run: () => {
        const editor = getActiveEditor();
        editor?.focus();
        editor?.trigger('keymap', 'editor.action.inlineSuggest.acceptNextLine', null);
      },
    },
  ]);
}
