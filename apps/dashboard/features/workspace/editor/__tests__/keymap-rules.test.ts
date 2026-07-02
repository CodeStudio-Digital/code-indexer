import { describe, expect, it } from 'vitest';
import { INTELLIJ_RULES, buildIntellijRules } from '../keymap-rules-intellij.js';

const fakeMonaco = {
  KeyMod: { CtrlCmd: 2048, Shift: 1024, Alt: 512, WinCtrl: 256 },
  KeyCode: {
    KeyB: 32, KeyD: 34, KeyJ: 40, KeyL: 42, KeyP: 46, KeyQ: 47, KeyW: 53, KeyY: 55,
    UpArrow: 16, DownArrow: 18, Enter: 3, F2: 60, F6: 64, F7: 65,
    Slash: 85, ABNT_C1: 115, NumpadDivide: 113, NumpadAdd: 104, NumpadSubtract: 106,
  },
} as unknown as Parameters<typeof buildIntellijRules>[0];

describe('INTELLIJ_RULES', () => {
  it('never binds one chord+when to two different commands', () => {
    const seen = new Map<string, string | null>();
    for (const r of INTELLIJ_RULES) {
      const chord = `${[...r.mods].sort().join('+')}+${r.key}|${r.when ?? ''}`;
      if (seen.has(chord)) {
        // A null unbind followed by a re-bind of the same chord is the one
        // sanctioned duplicate shape (F2: unbind rename, bind marker.next).
        expect(seen.get(chord)).toBeNull();
      }
      seen.set(chord, r.command);
    }
  });

  it('covers all three physical slash keys for both comment toggles', () => {
    for (const command of ['editor.action.commentLine', 'editor.action.blockComment']) {
      const keys = INTELLIJ_RULES.filter((r) => r.command === command).map((r) => r.key);
      expect(keys.sort()).toEqual(['ABNT_C1', 'NumpadDivide', 'Slash']);
    }
  });

  it('keeps the original 11 wave-6 bindings', () => {
    const byCommand = (cmd: string) => INTELLIJ_RULES.some((r) => r.command === cmd);
    for (const cmd of [
      'editor.action.copyLinesDownAction', 'editor.action.deleteLines',
      'editor.action.moveLinesUpAction', 'editor.action.moveLinesDownAction',
      'editor.action.formatDocument', 'editor.action.smartSelect.expand',
      'editor.action.smartSelect.shrink', 'editor.action.revealDefinition',
      'editor.action.goToReferences', 'editor.action.rename',
      'editor.action.addSelectionToNextFindMatch',
    ]) expect(byCommand(cmd), cmd).toBe(true);
  });
});

describe('buildIntellijRules', () => {
  it('composes modifier bitmasks against the runtime enum', () => {
    const rules = buildIntellijRules(fakeMonaco);
    const dup = rules.find((r) => r.command === 'editor.action.copyLinesDownAction');
    expect(dup?.keybinding).toBe(2048 | 34); // CtrlCmd | KeyD
    const block = rules.filter((r) => r.command === 'editor.action.blockComment');
    expect(block.map((r) => r.keybinding).sort((a, b) => a - b))
      .toEqual([2048 | 1024 | 85, 2048 | 1024 | 113, 2048 | 1024 | 115].sort((a, b) => a - b));
  });

  it('skips key names missing from the runtime enum instead of crashing', () => {
    const partial = {
      KeyMod: { CtrlCmd: 2048, Shift: 1024, Alt: 512 },
      KeyCode: { KeyD: 34 }, // everything else missing
    } as unknown as Parameters<typeof buildIntellijRules>[0];
    const rules = buildIntellijRules(partial);
    expect(rules.length).toBeGreaterThan(0);
    expect(rules.every((r) => typeof r.keybinding === 'number' && !Number.isNaN(r.keybinding))).toBe(true);
    expect(rules.some((r) => r.command === 'editor.action.commentLine')).toBe(false);
  });
});
