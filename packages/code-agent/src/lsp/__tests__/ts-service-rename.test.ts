/**
 * getRenameEdits — rename fim-a-fim no TS service (findRenameLocations).
 * Fixture multi-arquivo em disco (mkdtemp), SEM sqlite: pinos do contrato
 * 1-based (start inclusivo / end exclusivo), paths TS-canônicos absolutos,
 * cross-file (export + import + uso), e escopo (shadowing não é renomeado).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TsLanguageService, type RenameEdit } from '../ts-service.js';

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ts-rename-'));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

/** Aplica edits 1-based end-exclusivo a um conteúdo (verificação de round-trip). */
function apply(content: string, edits: RenameEdit[]): string {
  const lineStarts = [0];
  for (let i = 0; i < content.length; i++) if (content[i] === '\n') lineStarts.push(i + 1);
  const off = (p: { line: number; column: number }): number => lineStarts[p.line - 1] + p.column - 1;
  return edits
    .map((e) => ({ start: off(e.range.start), end: off(e.range.end), newText: e.newText }))
    .sort((a, b) => b.start - a.start)
    .reduce((acc, e) => acc.slice(0, e.start) + e.newText + acc.slice(e.end), content);
}

describe('TsLanguageService.getRenameEdits', () => {
  it('renames a symbol across files (declaration + import + usage)', () => {
    const aTs = 'export const foo = 1;\n';
    const bTs = "import { foo } from './a.js';\nconsole.log(foo + foo);\n";
    writeFileSync(join(root, 'a.ts'), aTs);
    writeFileSync(join(root, 'b.ts'), bTs);
    const svc = new TsLanguageService(root);
    // Preload b.ts como root — sem tsconfig, cada arquivo entra sob demanda.
    svc.getDiagnostics('b.ts');

    // Cursor sobre `foo` na declaração (linha 1, col 14).
    const edits = svc.getRenameEdits('a.ts', 1, 14, 'bar');
    expect(edits.length).toBeGreaterThanOrEqual(4); // decl + import + 2 usos

    // Paths absolutos TS-canônicos (forward slash) e ranges 1-based.
    for (const e of edits) {
      expect(e.file).not.toContain('\\');
      expect(e.range.start.line).toBeGreaterThanOrEqual(1);
      expect(e.range.start.column).toBeGreaterThanOrEqual(1);
    }

    const byFile = new Map<string, RenameEdit[]>();
    for (const e of edits) byFile.set(e.file, [...(byFile.get(e.file) ?? []), e]);
    expect(byFile.size).toBe(2);

    for (const [file, fileEdits] of byFile) {
      const original = file.endsWith('/a.ts') ? aTs : bTs;
      const renamed = apply(original, fileEdits);
      expect(renamed).not.toContain('foo');
      expect(renamed).toContain('bar');
    }
  });

  it('respects scope — a shadowing local is untouched', () => {
    const src = [
      'export const value = 1;',
      'export function f(): number {',
      '  const value = 2; // shadow — NÃO renomear',
      '  return value;',
      '}',
      'export const twice = value + value;',
      '',
    ].join('\n');
    writeFileSync(join(root, 'scope.ts'), src);
    const svc = new TsLanguageService(root);

    // Renomeia o `value` TOP-LEVEL (linha 1, col 14).
    const edits = svc.getRenameEdits('scope.ts', 1, 14, 'renamed');
    expect(edits.length).toBe(3); // decl + 2 usos na linha 6
    const renamed = apply(src, edits);
    expect(renamed).toContain('const renamed = 1;');
    expect(renamed).toContain('renamed + renamed;');
    // O shadow local permanece intacto.
    expect(renamed).toContain('const value = 2;');
    expect(renamed).toContain('return value;');
  });

  it('returns [] for a position with nothing renameable', () => {
    writeFileSync(join(root, 'empty.ts'), 'const x = 1;\n');
    const svc = new TsLanguageService(root);
    // Coluna 11 = o literal `1` — não renomeável.
    expect(svc.getRenameEdits('empty.ts', 1, 11, 'y')).toEqual([]);
  });

  it('reads the LIVE buffer (setFileSnapshot) instead of disk', () => {
    writeFileSync(join(root, 'live.ts'), 'const old = 1;\n');
    const svc = new TsLanguageService(root);
    svc.setFileSnapshot('live.ts', 'const fresh = 1;\nconst use = fresh;\n');
    const edits = svc.getRenameEdits('live.ts', 1, 7, 'renamed');
    expect(edits.length).toBe(2);
    const renamed = apply('const fresh = 1;\nconst use = fresh;\n', edits);
    expect(renamed).toBe('const renamed = 1;\nconst use = renamed;\n');
  });
});
