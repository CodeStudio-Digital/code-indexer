import { beforeEach, describe, it, expect } from 'vitest';
import { COMMAND_CATALOG } from '../../../../keymap/commands.js';
import { useKeymapStore } from '../../../../keymap/keymap-store.js';
import { bindingToMonaco, buildManagedMonacoRules } from '../monaco-keymap.js';

const fakeMonaco = {
  KeyCode: { RightArrow: 17 },
  KeyMod: { CtrlCmd: 2048, Shift: 1024, Alt: 512, chord: (a: number, b: number) => a * 10_000 + b },
} as never;

describe('AI completion catalogue binding', () => {
  beforeEach(() => useKeymapStore.setState({ preset: 'intellij', overrides: {} }));

  it('never binds Ctrl+Alt+Right — the IntelliJ preset owns it (navigate.forward, capture-phase dispatcher wins over Monaco)', () => {
    const command = COMMAND_CATALOG.find((item) => item.id === 'editor.aiComplete.acceptNextLine')!;
    expect(command.defaultKeys?.intellij).not.toContain('Ctrl+Alt+Right');
  });

  it('is visible in the single catalogue and gated to visible ghost text', () => {
    const command = COMMAND_CATALOG.find((item) => item.id === 'editor.aiComplete.acceptNextLine')!;
    expect(command.context).toContain('inlineSuggestionVisible');
    expect(command.context).toContain('editorTextFocus');
  });

  it('is emitted by the shared Monaco generator and skips unknown keys', () => {
    const rules = buildManagedMonacoRules(fakeMonaco)
      .filter((rule) => rule.command === 'editor.action.inlineSuggest.acceptNextLine');
    expect(rules).toHaveLength(1);
    expect(rules[0]!.keybinding).toBe(17 | 2048 | 1024); // Ctrl+Shift+Right

    expect(bindingToMonaco({ KeyCode: {}, KeyMod: { CtrlCmd: 0, Shift: 0, Alt: 0 } } as never, 'Ctrl+Shift+Right')).toEqual([]);
  });
});
