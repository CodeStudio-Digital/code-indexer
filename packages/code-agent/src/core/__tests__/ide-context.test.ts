/**
 * Onda 3b (Codex parity): structured IDE context rendering. Contract:
 *   - empty context → '' (no block)
 *   - renders active file, open tabs, and selections
 *   - selection without text self-closes; long text truncates; tabs cap
 */
import { describe, it, expect } from 'vitest';
import { formatIdeContext } from '../ide-context.js';

describe('formatIdeContext', () => {
  it('returns empty string for empty/undefined context', () => {
    expect(formatIdeContext(undefined)).toBe('');
    expect(formatIdeContext({})).toBe('');
    expect(formatIdeContext({ selections: [], openTabs: [] })).toBe('');
  });

  it('renders active file, open tabs, and a selection with text', () => {
    const out = formatIdeContext({
      activeFile: 'src/a.ts',
      openTabs: ['src/a.ts', 'src/b.ts'],
      selections: [{ path: 'src/a.ts', startLine: 10, endLine: 12, text: 'const x = 1;' }],
    });
    expect(out.startsWith('<ide_context>')).toBe(true);
    expect(out).toContain('active file: `src/a.ts`');
    expect(out).toContain('open tabs: `src/a.ts`, `src/b.ts`');
    expect(out).toContain('<selection path="src/a.ts" lines="10-12">\nconst x = 1;\n</selection>');
    expect(out.endsWith('</ide_context>')).toBe(true);
  });

  it('self-closes a selection without text', () => {
    const out = formatIdeContext({ selections: [{ path: 'x.ts', startLine: 1, endLine: 40 }] });
    expect(out).toContain('<selection path="x.ts" lines="1-40"></selection>');
  });

  it('truncates long selection text and caps the tab list', () => {
    const bigText = 'a'.repeat(5000);
    const manyTabs = Array.from({ length: 130 }, (_, i) => `f${i}.ts`);
    const out = formatIdeContext({ openTabs: manyTabs, selections: [{ path: 'x', startLine: 1, endLine: 2, text: bigText }] });
    expect(out).toContain('[…truncated]');
    expect(out).toContain('(+30 more)');
  });
});
