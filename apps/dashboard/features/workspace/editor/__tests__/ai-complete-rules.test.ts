import { describe, it, expect } from 'vitest';
import { AI_COMPLETE_RULES, buildAiCompleteRules } from '../ai-complete-commands.js';

const fakeMonaco = {
  KeyCode: { RightArrow: 17 },
  KeyMod: { CtrlCmd: 2048, Shift: 1024, Alt: 512 },
} as never;

describe('AI_COMPLETE_RULES', () => {
  it('never binds Ctrl+Alt+Right — the IntelliJ preset owns it (navigate.forward, capture-phase dispatcher wins over Monaco)', () => {
    for (const rule of AI_COMPLETE_RULES) {
      const mods = [...rule.mods].sort().join('+');
      expect(`${mods}+${rule.key}`).not.toBe('Alt+Ctrl+RightArrow');
    }
  });

  it('every rule is gated to visible ghost text in the editor', () => {
    for (const rule of AI_COMPLETE_RULES) {
      expect(rule.when).toContain('inlineSuggestionVisible');
      expect(rule.when).toContain('editorTextFocus');
    }
  });

  it('composes keybindings against the runtime enums, skipping unknown keys', () => {
    const rules = buildAiCompleteRules(fakeMonaco);
    expect(rules).toHaveLength(1);
    expect(rules[0]!.keybinding).toBe(17 | 2048 | 1024); // Ctrl+Shift+Right
    expect(rules[0]!.command).toBe('editor.action.inlineSuggest.acceptNextLine');

    const missing = buildAiCompleteRules({ KeyCode: {}, KeyMod: { CtrlCmd: 0, Shift: 0, Alt: 0 } } as never);
    expect(missing).toHaveLength(0); // unknown KeyCode name skips, not crashes
  });
});
