/**
 * Guards the theme catalog so it can't regress to the "variables look white"
 * bug: every custom theme must give `variable` a colour distinct from the
 * editor's default foreground, and must carry the rules that differentiate
 * function/method/property.
 */
import { describe, it, expect } from 'vitest';
import { EDITOR_THEMES } from '../catalog.js';

const REQUIRED_TOKENS = [
  'entity.name.function',
  'entity.name.function.member',
  'variable.other.property',
  'variable',
  'entity.name.type',
];

describe('editor theme catalog', () => {
  for (const theme of EDITOR_THEMES) {
    if (!theme.data) continue; // built-in vs/vs-dark carry no rules

    it(`${theme.id}: variable colour differs from default foreground (not washed out)`, () => {
      const fg = String(theme.data!.colors['editor.foreground'] ?? '').replace('#', '').toLowerCase();
      const variableRule = theme.data!.rules.find((r) => r.token === 'variable');
      expect(variableRule?.foreground).toBeTruthy();
      expect(variableRule!.foreground!.toLowerCase()).not.toBe(fg);
    });

    it(`${theme.id}: carries the differentiating token rules`, () => {
      const tokens = new Set(theme.data!.rules.map((r) => r.token));
      for (const t of REQUIRED_TOKENS) expect(tokens.has(t)).toBe(true);
    });
  }
});
