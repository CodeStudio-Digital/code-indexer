/**
 * Guards the theme catalog so it can't regress to the "variables look white"
 * bug: every custom theme must give `variable` a colour distinct from the
 * editor's default foreground, and must carry the rules that differentiate
 * function/method/property.
 */
import { describe, it, expect } from 'vitest';
import { EDITOR_THEMES } from '../catalog.js';

const REQUIRED_SYNTAX_TOKENS = [
  'entity.name.function',
  'entity.name.function.member',
  'variable.other.property',
  'variable',
  'identifier',
  'annotation',
  'entity.name.type',
];

const REQUIRED_SEMANTIC_TOKENS = [
  'function', 'method', 'class', 'enum', 'interface', 'struct', 'type',
  'typeParameter', 'namespace', 'property', 'event', 'member', 'parameter',
  'variable', 'enumMember',
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
      for (const t of [...REQUIRED_SYNTAX_TOKENS, ...REQUIRED_SEMANTIC_TOKENS]) {
        expect(tokens.has(t), `${theme.id} missing ${t}`).toBe(true);
      }
    });

    it(`${theme.id}: colors the suggest icons + popup chrome`, () => {
      const colors = theme.data!.colors;
      const HEX = /^#[0-9a-fA-F]{6}$/;
      for (const key of [
        'symbolIcon.methodForeground',
        'symbolIcon.classForeground',
        'symbolIcon.propertyForeground',
        'symbolIcon.variableForeground',
        'editorSuggestWidget.background',
        'editorSuggestWidget.selectedBackground',
        'editorSuggestWidget.border',
      ]) {
        expect(colors[key], `${theme.id} missing ${key}`).toMatch(HEX);
      }
      // Icons must actually differ by kind — method ≠ property ≠ class,
      // otherwise coloring them is pointless.
      expect(colors['symbolIcon.methodForeground'])
        .not.toBe(colors['symbolIcon.propertyForeground']);
    });
  }

  for (const id of ['codestudio-dark', 'codestudio-light']) {
    it(`${id}: keeps the main Java/C# symbol roles visually distinct`, () => {
      const theme = EDITOR_THEMES.find((entry) => entry.id === id)!;
      const colors = new Map(theme.data!.rules.map((entry) => [entry.token, entry.foreground]));
      const roles = ['class', 'namespace', 'method', 'property', 'parameter', 'variable'];

      for (const role of roles) expect(colors.get(role), `${id} missing ${role}`).toBeTruthy();
      expect(new Set(roles.map((role) => colors.get(role))).size).toBe(roles.length);
    });
  }
});
