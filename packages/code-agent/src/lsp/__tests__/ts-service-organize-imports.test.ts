/**
 * organizeImports — fim-a-fim no TS service (service.organizeImports, mode
 * All). Fixture em disco (mkdtemp), SEM sqlite: remove import não usado,
 * ordena por specifier, contrato 1-based end-exclusivo com paths TS-canônicos
 * absolutos (mesmas convenções do getRenameEdits).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TsLanguageService, type RenameEdit } from '../ts-service.js';

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ts-organize-'));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

/** Aplica edits 1-based end-exclusivo a um conteúdo (round-trip). */
function apply(content: string, edits: RenameEdit[]): string {
  const lineStarts = [0];
  for (let i = 0; i < content.length; i++) if (content[i] === '\n') lineStarts.push(i + 1);
  const off = (p: { line: number; column: number }): number => lineStarts[p.line - 1] + p.column - 1;
  return edits
    .map((e) => ({ start: off(e.range.start), end: off(e.range.end), newText: e.newText }))
    .sort((a, b) => b.start - a.start)
    .reduce((acc, e) => acc.slice(0, e.start) + e.newText + acc.slice(e.end), content);
}

describe('TsLanguageService.organizeImports', () => {
  it('drops unused imports and sorts the rest', () => {
    writeFileSync(join(root, 'a.ts'), 'export const a = 1;\n');
    writeFileSync(join(root, 'u.ts'), 'export const unused = 2;\n');
    writeFileSync(join(root, 'z.ts'), 'export const z = 3;\n');
    const src = [
      "import { z } from './z.js';",
      "import { unused } from './u.js';",
      "import { a } from './a.js';",
      '',
      'export const v = a + z;',
      '',
    ].join('\n');
    writeFileSync(join(root, 'main.ts'), src);
    const svc = new TsLanguageService(root);

    const edits = svc.organizeImports('main.ts');
    expect(edits.length).toBeGreaterThan(0);

    // Paths absolutos TS-canônicos, ranges 1-based e todos no MESMO arquivo.
    for (const e of edits) {
      expect(e.file).not.toContain('\\');
      expect(e.file.endsWith('/main.ts')).toBe(true);
      expect(e.range.start.line).toBeGreaterThanOrEqual(1);
      expect(e.range.start.column).toBeGreaterThanOrEqual(1);
    }

    const out = apply(src, edits);
    expect(out).not.toContain('unused');
    expect(out.indexOf("'./a.js'")).toBeLessThan(out.indexOf("'./z.js'"));
    expect(out).toContain('export const v = a + z;');
  });

  it('returns [] when there is nothing to organize', () => {
    writeFileSync(join(root, 'b.ts'), 'export const b = 1;\n');
    const svc = new TsLanguageService(root);
    expect(svc.organizeImports('b.ts')).toEqual([]);
  });

  it('reads the LIVE buffer (setFileSnapshot) instead of disk', () => {
    writeFileSync(join(root, 'a.ts'), 'export const a = 1;\n');
    writeFileSync(join(root, 'live.ts'), 'export const v = 1;\n');
    const svc = new TsLanguageService(root);
    const live = "import { a } from './a.js';\nexport const v = 1;\n";
    svc.setFileSnapshot('live.ts', live);
    const edits = svc.organizeImports('live.ts');
    expect(edits.length).toBeGreaterThan(0);
    const out = apply(live, edits);
    expect(out).not.toContain('./a.js'); // unused import removed from the live text
  });
});
