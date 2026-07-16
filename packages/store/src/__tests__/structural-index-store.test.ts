/**
 * Structural store primitives. Semantic generations are intentionally kept
 * outside the file row.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { CodeIndexDB } from '../db.js';
import type { LLMSymbol } from '@mcp/shared/types.js';

const FULL_FILE = {
  path: 'src/auth/service.ts',
  language: 'typescript',
  size: 1000,
  lineCount: 50,
  contentHash: 'hash-v1',
  dependencies: ['./client'],
  internalDeps: ['./client'],
  externalDeps: ['jose'],
  isEntryPoint: false,
  isTest: false,
  isGenerated: false,
};

function indexedSymbol(name: string): LLMSymbol {
  return {
    name,
    kind: 'function',
    signature: `${name}()`,
    parent: null,
    modifiers: [],
    return_type: null,
    parameters: '()',
    line: 1,
    col: 1,
    end_line: 1,
    exported: true,
    comment: null,
    tags: [],
  };
}

describe('structural index store (migrations 139/140)', () => {
  let dir: string;
  let db: CodeIndexDB;
  let projectId: number;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'mcp-structural-'));
    db = new CodeIndexDB(join(dir, 'test.db'));
    projectId = db.createProject('p', dir).id;
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('creates a structural row and indexes its path', () => {
    const { fileId, created } = db.upsertFileStructural(projectId, {
      path: 'src/new.ts', language: 'typescript', size: 10, lineCount: 2,
      contentHash: 'h1', dependencies: [], internalDeps: [], externalDeps: [],
    });
    expect(created).toBe(true);
    const row = db.getFile(projectId, 'src/new.ts')!;
    expect(row.id).toBe(fileId);
    expect(row.is_entry_point).toBe(0);
    expect(row.is_test).toBe(0);
    expect(row.is_generated).toBe(0);
    // files_ai trigger indexed the path.
    const fts = db.raw().prepare(
      "SELECT rowid FROM files_fts WHERE files_fts MATCH 'new'"
    ).all() as Array<{ rowid: number }>;
    expect(fts.map((r) => r.rowid)).toContain(fileId);
  });

  it('updates structural facts in place without a second source of semantic truth', () => {
    const fileId = db.upsertFile(projectId, FULL_FILE);

    const { created } = db.upsertFileStructural(projectId, {
      path: FULL_FILE.path, language: 'typescript', size: 1200, lineCount: 60,
      contentHash: 'hash-v2', dependencies: ['./client', './other'],
      internalDeps: ['./client', './other'], externalDeps: ['jose'],
      isEntryPoint: true, isTest: false, isGenerated: false,
    });
    expect(created).toBe(false);

    const row = db.getFile(projectId, FULL_FILE.path)!;
    expect(row.id).toBe(fileId);
    expect(row.content_hash).toBe('hash-v2');           // structural advanced
    expect(row.size).toBe(1200);
    expect(JSON.parse(row.dependencies)).toEqual(['./client', './other']);
    expect(row.is_entry_point).toBe(1);
  });

  it('content FTS: upsert + search + AD trigger + guard', () => {
    const { fileId } = db.upsertFileStructural(projectId, {
      path: 'src/a.ts', language: 'typescript', size: 50, lineCount: 3,
      contentHash: 'h', dependencies: [], internalDeps: [], externalDeps: [],
    });
    expect(db.upsertFileContent(fileId, 'export function refreshToken() {\n  return rotateKeys();\n}')).toBe(true);

    const hits = db.searchFileContents(projectId, 'rotateKeys');
    expect(hits.map((h) => h.path)).toEqual(['src/a.ts']);

    // Re-upsert (edit) replaces — old token stops matching.
    expect(db.upsertFileContent(fileId, 'export const nothing = 1;\n')).toBe(true);
    expect(db.searchFileContents(projectId, 'rotateKeys')).toHaveLength(0);
    expect(db.searchFileContents(projectId, 'nothing')).toHaveLength(1);

    // Minified content is rejected AND clears the stale entry.
    expect(db.upsertFileContent(fileId, 'x'.repeat(2000))).toBe(false);
    expect(db.searchFileContents(projectId, 'nothing')).toHaveLength(0);
    expect(db.countFileContents(projectId)).toBe(0);

    // Repopulate, then deleting the file row must clear the index (AD trigger).
    db.upsertFileContent(fileId, 'const back = true;\n');
    expect(db.countFileContents(projectId)).toBe(1);
    db.deleteFile(projectId, 'src/a.ts');
    expect(db.countFileContents(projectId)).toBe(0);
  });

  it('rejects binary-ish content (NUL byte)', () => {
    const { fileId } = db.upsertFileStructural(projectId, {
      path: 'src/bin.dat', language: 'unknown', size: 10, lineCount: 1,
      contentHash: 'h', dependencies: [], internalDeps: [], externalDeps: [],
    });
    expect(db.upsertFileContent(fileId, `abc${String.fromCharCode(0)}def`)).toBe(false);
  });

  it('filters prefix symbols by language before the limit and keeps project isolation', () => {
    const python = db.upsertFileStructural(projectId, {
      path: 'src/target.py', language: 'python', size: 10, lineCount: 1,
      contentHash: 'py', dependencies: [], internalDeps: [], externalDeps: [],
    });
    db.upsertSymbols(projectId, python.fileId, 'src/target.py', [indexedSymbol('aczPythonTarget')]);

    const typescript = db.upsertFileStructural(projectId, {
      path: 'src/noise.ts', language: 'typescript', size: 10, lineCount: 1,
      contentHash: 'ts', dependencies: [], internalDeps: [], externalDeps: [],
    });
    db.upsertSymbols(
      projectId,
      typescript.fileId,
      'src/noise.ts',
      Array.from({ length: 55 }, (_, i) => indexedSymbol(`ac${String(i).padStart(3, '0')}TsNoise`)),
    );

    const otherProjectId = db.createProject('other', join(dir, 'other')).id;
    const otherPython = db.upsertFileStructural(otherProjectId, {
      path: 'src/other.py', language: 'python', size: 10, lineCount: 1,
      contentHash: 'other-py', dependencies: [], internalDeps: [], externalDeps: [],
    });
    db.upsertSymbols(otherProjectId, otherPython.fileId, 'src/other.py', [indexedSymbol('acaOtherProject')]);

    const hits = db.searchSymbolsByPrefix(projectId, 'ac', 50, {
      exportedOnly: true,
      languages: ['python'],
    });
    expect(hits.map((s) => s.name)).toEqual(['aczPythonTarget']);
  });

  it('accepts multiple compatible structural languages in one prefix query', () => {
    const seed = (path: string, language: string, symbol: string): void => {
      const { fileId } = db.upsertFileStructural(projectId, {
        path, language, size: 10, lineCount: 1,
        contentHash: path, dependencies: [], internalDeps: [], externalDeps: [],
      });
      db.upsertSymbols(projectId, fileId, path, [indexedSymbol(symbol)]);
    };
    seed('src/a.ts', 'typescript', 'shareTypescript');
    seed('src/b.tsx', 'tsx', 'shareTsx');
    seed('src/c.js', 'javascript', 'shareJavascript');
    seed('src/d.py', 'python', 'sharePython');

    const hits = db.searchSymbolsByPrefix(projectId, 'share', 50, {
      exportedOnly: true,
      languages: ['typescript', 'tsx', 'javascript'],
    });
    expect(new Set(hits.map((s) => s.name))).toEqual(new Set([
      'shareTypescript', 'shareTsx', 'shareJavascript',
    ]));
  });

  it('missingContentFiles feeds the coverage sweep; repair recreates empty', () => {
    const a = db.upsertFileStructural(projectId, {
      path: 'src/a.ts', language: 'typescript', size: 10, lineCount: 1,
      contentHash: 'h', dependencies: [], internalDeps: [], externalDeps: [],
    });
    db.upsertFileStructural(projectId, {
      path: 'src/b.ts', language: 'typescript', size: 10, lineCount: 1,
      contentHash: 'h', dependencies: [], internalDeps: [], externalDeps: [],
    });
    db.upsertFileContent(a.fileId, 'const a = 1;\n');
    expect(db.missingContentFiles(projectId).map((f) => f.path)).toEqual(['src/b.ts']);

    // Corruption drill: repair must not throw and must come back EMPTY
    // (contentless cannot 'rebuild'); the sweep then sees both files missing.
    db.repairFtsIndexes();
    expect(db.countFileContents(projectId)).toBe(0);
    expect(db.missingContentFiles(projectId)).toHaveLength(2);
  });

  it('getByPath: normalized equality, never suffix-match a different project', () => {
    const a = db.createProject('backend-a', 'D:\\poa-monorepo\\backend');
    db.createProject('backend-b', 'F:\\outro\\backend');

    // Slash/case/trailing variants of the SAME root resolve to it.
    expect(db.getProjectByPath('d:/poa-monorepo/backend/')!.id).toBe(a.id);
    expect(db.getProjectByPath('D:\\POA-MONOREPO\\BACKEND')!.id).toBe(a.id);
    // The old `LIKE '%' || ?` suffix fallback matched ANY root ending in
    // "\backend" — a bare suffix must now resolve to nothing.
    expect(db.getProjectByPath('\\backend')).toBeUndefined();
    expect(db.getProjectByPath('backend')).toBeUndefined();
  });

  it('keeps structural reconciliation history without LLM telemetry', () => {
    const finish = {
      status: 'completed' as const, totalFiles: 1, indexedFiles: 1, skippedFiles: 0,
      errorCount: 0,
    };
    const structural = db.startRun(projectId);
    db.finishRun(structural, finish);

    expect(db.getRun(structural)).toMatchObject({
      project_id: projectId,
      status: 'completed',
      indexed_files: 1,
      total_files: 1,
    });
    expect(db.getRuns(projectId)).toHaveLength(1);
  });
});
