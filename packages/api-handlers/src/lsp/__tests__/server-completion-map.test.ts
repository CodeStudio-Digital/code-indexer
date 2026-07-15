import { describe, expect, it } from 'vitest';
import { filterServerCompletionItems, mapServerCodeActions, mapServerCompletionItem, mapServerWorkspaceEdit } from '../server-backend.js';
import type { LspCompletionItem } from '@mcp/services/lsp/lsp-protocol.js';

describe('mapServerCompletionItem', () => {
  it('converts additionalTextEdits from 0-based LSP to 1-based contract ranges', () => {
    const lsp: LspCompletionItem = {
      label: 'ProfileService',
      kind: 7,
      additionalTextEdits: [
        {
          // use-statement inserted at the top of the file (line 2, col 0).
          range: { start: { line: 2, character: 0 }, end: { line: 2, character: 0 } },
          newText: 'use App\\Services\\ProfileService;\n',
        },
      ],
    };
    const item = mapServerCompletionItem(lsp);
    expect(item.additionalTextEdits).toEqual([
      {
        range: { start: { line: 3, column: 1 }, end: { line: 3, column: 1 } },
        newText: 'use App\\Services\\ProfileService;\n',
      },
    ]);
  });

  it('prefers textEdit.newText over insertText over label', () => {
    expect(mapServerCompletionItem({ label: 'a', insertText: 'b', textEdit: { newText: 'c' } }).insertText).toBe('c');
    expect(mapServerCompletionItem({ label: 'a', insertText: 'b' }).insertText).toBe('b');
    expect(mapServerCompletionItem({ label: 'a' }).insertText).toBe('a');
  });

  it('echoes the original LSP item as raw (resolve round-trip token)', () => {
    const lsp: LspCompletionItem = { label: 'X', data: { importPath: 'App\\X' } };
    expect(mapServerCompletionItem(lsp).raw).toBe(lsp);
  });

  it('leaves additionalTextEdits undefined when the server deferred them', () => {
    expect(mapServerCompletionItem({ label: 'X' }).additionalTextEdits).toBeUndefined();
  });

  it('passes through the fidelity fields (sortText/insertTextFormat/etc.)', () => {
    const lsp: LspCompletionItem = {
      label: 'foo', sortText: '0001', filterText: 'foo', insertTextFormat: 2,
      preselect: true, labelDetails: { detail: '(int $a)', description: 'App\\X' },
      commitCharacters: ['(', '.'],
    };
    const item = mapServerCompletionItem(lsp);
    expect(item.sortText).toBe('0001');
    expect(item.insertTextFormat).toBe(2);
    expect(item.preselect).toBe(true);
    expect(item.labelDetails).toEqual({ detail: '(int $a)', description: 'App\\X' });
    expect(item.commitCharacters).toEqual(['(', '.']);
  });

  it('converts an InsertReplaceEdit, preferring the replace range (1-based)', () => {
    const lsp: LspCompletionItem = {
      label: 'method',
      textEdit: {
        newText: 'method',
        insert: { start: { line: 4, character: 8 }, end: { line: 4, character: 10 } },
        replace: { start: { line: 4, character: 8 }, end: { line: 4, character: 14 } },
      },
    };
    const item = mapServerCompletionItem(lsp);
    expect(item.textEdit).toEqual({
      range: { start: { line: 5, column: 9 }, end: { line: 5, column: 15 } },
      newText: 'method',
    });
    expect(item.insertText).toBe('method');
  });

  it('lifts the Intelephense `use FQN` detail into a right-aligned namespace', () => {
    const item = mapServerCompletionItem({
      label: 'Past', detail: 'use infrastructure\\core\\attributes\\validation\\Past',
    });
    expect(item.labelDetails).toEqual({ description: 'infrastructure\\core\\attributes\\validation' });
    expect(item.detail).toBeUndefined(); // redundant `use …` dropped
  });

  it('keeps a real signature detail (does not touch non-`use` details)', () => {
    const item = mapServerCompletionItem({ label: 'foo', detail: '(int $a): void' });
    expect(item.detail).toBe('(int $a): void');
    expect(item.labelDetails).toBeUndefined();
  });

  it('leaves an already-bracketed label alone (no double namespace)', () => {
    const item = mapServerCompletionItem({
      label: 'Password [infrastructure\\core\\general]', detail: 'use infrastructure\\core\\general\\Password',
    });
    expect(item.labelDetails).toBeUndefined();
    expect(item.detail).toBe('use infrastructure\\core\\general\\Password');
  });

  it('uses a plain TextEdit range when there is no insert/replace', () => {
    const lsp: LspCompletionItem = {
      label: 'x', textEdit: { newText: 'xyz', range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } } },
    };
    expect(mapServerCompletionItem(lsp).textEdit).toEqual({
      range: { start: { line: 1, column: 1 }, end: { line: 1, column: 2 } },
      newText: 'xyz',
    });
  });
});

describe('filterServerCompletionItems', () => {
  it('filters before the cap and preserves a match beyond the former item 120 cutoff', () => {
    const items = Array.from({ length: 620 }, (_, index) => ({
      label: index === 180 ? 'IEnumerable' : `Other${index}`,
      sortText: String(index).padStart(4, '0'),
    }));
    const result = filterServerCompletionItems(items, 'IEnumera', { line: 1, column: 9 });
    expect(result.items.map((item) => item.label)).toEqual(['IEnumerable']);
    expect(result.truncated).toBe(false);
  });

  it('caps a broad ranked list at 500 and reports truncation', () => {
    const items = Array.from({ length: 501 }, (_, index) => ({ label: `Item${index}` }));
    const result = filterServerCompletionItems(items, '', { line: 1, column: 1 });
    expect(result.items).toHaveLength(500);
    expect(result.items[0]?.label).toBe('Item0');
    expect(result.items[499]?.label).toBe('Item499');
    expect(result.truncated).toBe(true);
  });
});

describe('mapServerWorkspaceEdit', () => {
  it('converts changes from URI keys into absolute-path contract edits', () => {
    expect(mapServerWorkspaceEdit({
      changes: {
        'file:///d:/proj/src/a.php': [
          { range: { start: { line: 1, character: 0 }, end: { line: 1, character: 0 } }, newText: 'use App\\A;\n' },
        ],
      },
    })).toEqual({
      changes: {
        'd:/proj/src/a.php': [
          { range: { start: { line: 2, column: 1 }, end: { line: 2, column: 1 } }, newText: 'use App\\A;\n' },
        ],
      },
    });
  });

  it('converts documentChanges textDocument edits too', () => {
    expect(mapServerWorkspaceEdit({
      documentChanges: [
        {
          textDocument: { uri: 'file:///d:/proj/src/b.ts', version: 3 },
          edits: [
            { range: { start: { line: 0, character: 2 }, end: { line: 0, character: 5 } }, newText: 'Thing' },
          ],
        },
      ],
    })).toEqual({
      changes: {
        'd:/proj/src/b.ts': [
          { range: { start: { line: 1, column: 3 }, end: { line: 1, column: 6 } }, newText: 'Thing' },
        ],
      },
    });
  });

  it('ignores non-file URIs from either workspace edit shape', () => {
    expect(mapServerWorkspaceEdit({
      changes: {
        'untitled:Scratch.java': [
          { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } }, newText: 'x' },
        ],
      },
      documentChanges: [{
        textDocument: { uri: 'jdt://contents/java.base/java/lang/String.class', version: 1 },
        edits: [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } }, newText: 'x' }],
      }],
    })).toBeUndefined();
  });
});

describe('mapServerCodeActions', () => {
  it('keeps edit-backed, command-backed and lazy-resolvable actions', () => {
    const actions = mapServerCodeActions([
      {
        title: 'Import class',
        kind: 'quickfix',
        isPreferred: true,
        edit: {
          changes: {
            'file:///d:/proj/src/a.php': [
              { range: { start: { line: 3, character: 0 }, end: { line: 3, character: 0 } }, newText: 'use App\\A;\n' },
            ],
          },
        },
      },
      { title: 'Run server command', command: { command: 'x', arguments: [1] } },
      { title: 'Bare LSP command', command: 'omnisharp.applyCodeAction', arguments: [{ id: 9 }] },
      { title: 'Resolve later', data: { id: 7 } },
    ], 'intelephense');

    expect(actions).toEqual([
      {
        title: 'Import class',
        kind: 'quickfix',
        isPreferred: true,
        edit: {
          changes: {
            'd:/proj/src/a.php': [
              { range: { start: { line: 4, column: 1 }, end: { line: 4, column: 1 } }, newText: 'use App\\A;\n' },
            ],
          },
        },
        command: undefined,
        originServerId: 'intelephense',
        raw: expect.any(Object),
        needsResolve: false,
      },
      {
        title: 'Run server command', kind: 'quickfix', isPreferred: undefined, edit: undefined,
        command: { command: 'x', arguments: [1] }, originServerId: 'intelephense',
        raw: expect.any(Object), needsResolve: false,
      },
      {
        title: 'Bare LSP command', kind: 'quickfix', isPreferred: undefined, edit: undefined,
        command: { command: 'omnisharp.applyCodeAction', arguments: [{ id: 9 }] },
        originServerId: 'intelephense', raw: expect.any(Object), needsResolve: false,
      },
      {
        title: 'Resolve later', kind: 'quickfix', isPreferred: undefined, edit: undefined,
        command: undefined, originServerId: 'intelephense', raw: expect.any(Object), needsResolve: true,
      },
    ]);
  });
});
