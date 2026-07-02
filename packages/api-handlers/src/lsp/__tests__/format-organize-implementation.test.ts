/**
 * Onda F+G+J — pure mappers/fallbacks: formatting TextEdit map, organize-
 * imports codeAction picker, implementation index fallback. No sqlite: db
 * objects are hand-rolled fakes (ABI-gate friendly).
 */
import { describe, expect, it } from 'vitest';
import type { DBSymbol } from '@mcp/shared/types.js';
import { mapServerTextEdits, pickOrganizeImportsEdits } from '../server-backend-ops.js';
import { fallbackImplementation } from '../fallback-implementation.js';

const r0 = (l1: number, c1: number, l2: number, c2: number) => ({
  start: { line: l1, character: c1 },
  end: { line: l2, character: c2 },
});

describe('mapServerTextEdits', () => {
  it('converts 0-based LSP edits to 1-based DTOs', () => {
    const out = mapServerTextEdits([
      { range: r0(0, 0, 0, 4), newText: '    ' },
      { range: r0(2, 1, 3, 0), newText: '' },
    ]);
    expect(out).toEqual([
      { range: { start: { line: 1, column: 1 }, end: { line: 1, column: 5 } }, newText: '    ' },
      { range: { start: { line: 3, column: 2 }, end: { line: 4, column: 1 } }, newText: '' },
    ]);
  });

  it('filters garbage and non-array payloads', () => {
    expect(mapServerTextEdits(null)).toEqual([]);
    expect(mapServerTextEdits({})).toEqual([]);
    expect(mapServerTextEdits([{ newText: 'x' }, null, { range: r0(0, 0, 0, 1) }])).toEqual([]);
  });
});

describe('pickOrganizeImportsEdits', () => {
  const uri = 'file:///d:/proj/app.py';
  const editFor = (newText: string) => ({
    changes: { [uri]: [{ range: r0(0, 0, 2, 0), newText }] },
  });

  it('picks the FIRST source.organizeImports action with an edit → flat edits', () => {
    const out = pickOrganizeImportsEdits([
      { title: 'Fix typo', kind: 'quickfix', edit: editFor('nope') },
      { title: 'Organize (no edit)', kind: 'source.organizeImports' }, // command-only → skipped
      { title: 'Organize Imports', kind: 'source.organizeImports', edit: editFor('import a\nimport b\n') },
      { title: 'Organize Imports (later)', kind: 'source.organizeImports', edit: editFor('later') },
    ]);
    expect(out).toEqual([{
      file: 'd:/proj/app.py',
      range: { start: { line: 1, column: 1 }, end: { line: 3, column: 1 } },
      newText: 'import a\nimport b\n',
    }]);
  });

  it('matches kind prefixes (source.organizeImports.ruff style)', () => {
    const out = pickOrganizeImportsEdits([
      { title: 'Organize', kind: 'source.organizeImports.ruff', edit: editFor('x') },
    ]);
    expect(out).toHaveLength(1);
  });

  it('returns [] when no organize action exists (Intelephense free)', () => {
    expect(pickOrganizeImportsEdits([{ title: 'Fix', kind: 'quickfix', edit: editFor('x') }])).toEqual([]);
    expect(pickOrganizeImportsEdits([])).toEqual([]);
    expect(pickOrganizeImportsEdits(null)).toEqual([]);
  });
});

describe('fallbackImplementation (fake db)', () => {
  const sym = (over: Partial<DBSymbol>): DBSymbol => ({
    id: 1, project_id: 1, file_id: 1, file_path: 'a.php', name: 'x', kind: 'class',
    signature: '', parent: null, namespace: null, modifiers: '[]', return_type: null,
    parameters: null, line: 1, col: 1, end_line: 2, exported: 1, comment: null,
    tags: '[]', created_at: '', stable_id: null, ...over,
  } as DBSymbol);

  const db = {
    getImplementors: (_p: number, name: string) =>
      name === 'Repo' ? [sym({ name: 'SqlRepo', file_path: 'src/SqlRepo.php', line: 5, col: 7 })] : [],
    getSubclasses: (_p: number, name: string) =>
      name === 'Repo'
        ? [
            sym({ name: 'SqlRepo', file_path: 'src/SqlRepo.php', line: 5, col: 7 }), // dup with implementors
            sym({ name: 'MemRepo', file_path: 'src/MemRepo.php', line: 3, col: 7 }),
          ]
        : [],
  };

  it('maps implementors + subclasses to ABSOLUTE locations, deduped', () => {
    const content = 'interface Repo {}\n$x = new Repo();\n';
    // Cursor on `Repo` (line 1, col 11).
    const out = fallbackImplementation(db, 1, 'd:/proj', content, { line: 1, column: 11 });
    expect(out).toEqual([
      {
        file: 'd:/proj/src/SqlRepo.php',
        range: { start: { line: 5, column: 7 }, end: { line: 5, column: 7 + 'SqlRepo'.length } },
      },
      {
        file: 'd:/proj/src/MemRepo.php',
        range: { start: { line: 3, column: 7 }, end: { line: 3, column: 7 + 'MemRepo'.length } },
      },
    ]);
  });

  it('returns [] when no word sits under the cursor', () => {
    expect(fallbackImplementation(db, 1, 'd:/proj', '   \n', { line: 1, column: 2 })).toEqual([]);
  });
});
