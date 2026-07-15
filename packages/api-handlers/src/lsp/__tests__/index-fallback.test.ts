import { describe, expect, it, vi } from 'vitest';
import type { CodeIndexDB } from '@mcp/store/db.js';
import type { DBSymbol } from '@mcp/shared/types.js';
import { closeDoc, openDoc } from '../document-store.js';
import { completionIndexLanguages, fallbackCompletion } from '../index-fallback.js';

interface Candidate {
  language: string;
  symbol: DBSymbol;
}

function symbol(name: string, filePath: string): DBSymbol {
  return {
    id: 1,
    project_id: 901,
    file_id: 1,
    file_path: filePath,
    name,
    kind: 'function',
    signature: `${name}()`,
    parent: null,
    namespace: null,
    modifiers: '[]',
    return_type: null,
    parameters: '()',
    line: 1,
    col: 1,
    end_line: 1,
    exported: 1,
    comment: null,
    tags: '[]',
    stable_id: `stable:${filePath}:${name}`,
    created_at: '',
  };
}

function fakeDb(indexedLanguage: string, candidates: Candidate[]) {
  const searchSymbolsByPrefix = vi.fn((
    _projectId: number,
    prefix: string,
    limit: number,
    opts?: { exportedOnly?: boolean; languages?: readonly string[] },
  ) => candidates
    .filter((candidate) => candidate.symbol.name.startsWith(prefix))
    .filter((candidate) => opts?.languages?.includes(candidate.language))
    .slice(0, limit)
    .map((candidate) => candidate.symbol));
  const db = {
    getFile: () => ({ id: 1, language: indexedLanguage }),
    getDependencies: () => [],
    getSymbolsByFile: () => [],
    searchSymbolsByPrefix,
  } as unknown as CodeIndexDB;
  return { db, searchSymbolsByPrefix };
}

function complete(
  file: string,
  indexedLanguage: string,
  editorLanguage: string,
  candidates: Candidate[],
) {
  const projectId = 901;
  const { db, searchSymbolsByPrefix } = fakeDb(indexedLanguage, candidates);
  openDoc(projectId, file, editorLanguage, 1, 'ac');
  try {
    const items = fallbackCompletion(db, projectId, 'D:/project', file, { line: 1, column: 3 }, editorLanguage);
    return { items, searchSymbolsByPrefix };
  } finally {
    closeDoc(projectId, file);
  }
}

describe('completionIndexLanguages', () => {
  it('keeps exact languages isolated and groups only the declared compatible families', () => {
    expect(completionIndexLanguages('python', 'python')).toEqual(['python']);
    expect(completionIndexLanguages('php', 'php')).toEqual(['php']);
    expect(completionIndexLanguages('typescript', 'typescript')).toEqual(['typescript', 'tsx', 'javascript']);
    expect(completionIndexLanguages('css', 'scss')).toEqual(['css', 'scss', 'less']);
    expect(completionIndexLanguages('bash', 'shell')).toEqual(['bash', 'shell']);
  });

  it('uses the editor language for a missing/stale index row and disables unknown files', () => {
    expect(completionIndexLanguages(undefined, 'python')).toEqual(['python']);
    expect(completionIndexLanguages('unknown', 'python')).toEqual(['python']);
    expect(completionIndexLanguages('unknown', 'plaintext')).toEqual([]);
    expect(completionIndexLanguages(undefined, undefined)).toEqual([]);
  });
});

describe('fallbackCompletion language isolation', () => {
  it('does not mix TypeScript project symbols into a Python completion', () => {
    const { items, searchSymbolsByPrefix } = complete('src/main.py', 'python', 'python', [
      { language: 'python', symbol: symbol('acPython', 'src/python_helpers.py') },
      { language: 'typescript', symbol: symbol('acceptAllScope', 'src/session-scope.ts') },
      { language: 'typescript', symbol: symbol('accountRouter', 'src/routes.ts') },
    ]);

    expect(items.map((item) => item.label)).toEqual(['acPython']);
    expect(searchSymbolsByPrefix).toHaveBeenCalledWith(901, 'ac', 50, {
      exportedOnly: true,
      languages: ['python'],
    });
  });

  it('keeps TS, TSX and JS together while excluding Python and PHP', () => {
    const { items } = complete('src/main.ts', 'typescript', 'typescript', [
      { language: 'typescript', symbol: symbol('acTypescript', 'src/a.ts') },
      { language: 'tsx', symbol: symbol('acTsx', 'src/b.tsx') },
      { language: 'javascript', symbol: symbol('acJavascript', 'src/c.js') },
      { language: 'python', symbol: symbol('acPython', 'src/d.py') },
      { language: 'php', symbol: symbol('acPhp', 'src/e.php') },
    ]);

    expect(new Set(items.map((item) => item.label))).toEqual(new Set([
      'acTypescript', 'acTsx', 'acJavascript',
    ]));
  });

  it('keeps private symbols from the current file even when project-wide fallback is disabled', () => {
    const projectId = 901;
    const local = symbol('acLocalPrivate', 'notes.txt');
    local.exported = 0;
    const searchSymbolsByPrefix = vi.fn(() => [symbol('acProject', 'src/project.ts')]);
    const db = {
      getFile: () => ({ id: 1, language: 'unknown' }),
      getDependencies: () => [],
      getSymbolsByFile: () => [local],
      searchSymbolsByPrefix,
    } as unknown as CodeIndexDB;
    openDoc(projectId, 'notes.txt', 'plaintext', 1, 'ac');
    try {
      const items = fallbackCompletion(db, projectId, 'D:/project', 'notes.txt', { line: 1, column: 3 }, 'plaintext');
      expect(items.map((item) => item.label)).toEqual(['acLocalPrivate']);
      expect(searchSymbolsByPrefix).not.toHaveBeenCalled();
    } finally {
      closeDoc(projectId, 'notes.txt');
    }
  });
});
