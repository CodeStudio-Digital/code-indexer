/**
 * Migrations 139/140 — structural-layer store primitives.
 *
 * The load-bearing regression here: upsertFileStructural must NEVER erase the
 * semantic layer (summary/concepts/semantic_hash) written by a full index —
 * that's the whole dumb→smart contract.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { CodeIndexDB } from '../db.js';

const FULL_FILE = {
  path: 'src/auth/service.ts',
  language: 'typescript',
  size: 1000,
  lineCount: 50,
  contentHash: 'hash-v1',
  summary: 'Auth service with token refresh',
  concepts: ['auth', 'jwt'],
  dependencies: ['./client'],
  internalDeps: ['./client'],
  externalDeps: ['jose'],
  notes: ['n1'],
  complexity: 'medium',
  layer: 'service',
};

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

  it('creates a new file row with empty semantic defaults', () => {
    const { fileId, created } = db.upsertFileStructural(projectId, {
      path: 'src/new.ts', language: 'typescript', size: 10, lineCount: 2,
      contentHash: 'h1', dependencies: [], internalDeps: [], externalDeps: [],
    });
    expect(created).toBe(true);
    const row = db.getFile(projectId, 'src/new.ts')!;
    expect(row.id).toBe(fileId);
    expect(row.summary).toBe('');
    expect(row.concepts).toBe('[]');
    expect(row.semantic_hash).toBeNull();
    // files_ai trigger indexed the path.
    const fts = db.raw().prepare(
      "SELECT rowid FROM files_fts WHERE files_fts MATCH 'new'"
    ).all() as Array<{ rowid: number }>;
    expect(fts.map((r) => r.rowid)).toContain(fileId);
  });

  it('UPDATE path preserves the semantic layer (central regression)', () => {
    const fileId = db.upsertFile(projectId, FULL_FILE);
    db.setFileSemanticHash(projectId, FULL_FILE.path, 'hash-v1');
    expect(db.countSemanticStale(projectId)).toBe(0);

    const { created } = db.upsertFileStructural(projectId, {
      path: FULL_FILE.path, language: 'typescript', size: 1200, lineCount: 60,
      contentHash: 'hash-v2', dependencies: ['./client', './other'],
      internalDeps: ['./client', './other'], externalDeps: ['jose'],
    });
    expect(created).toBe(false);

    const row = db.getFile(projectId, FULL_FILE.path)!;
    expect(row.id).toBe(fileId);
    expect(row.content_hash).toBe('hash-v2');           // structural advanced
    expect(row.size).toBe(1200);
    expect(row.summary).toBe(FULL_FILE.summary);        // semantics intact
    expect(JSON.parse(row.concepts)).toEqual(['auth', 'jwt']);
    expect(row.layer).toBe('service');
    expect(row.semantic_hash).toBe('hash-v1');          // untouched → stale marker
    expect(db.countSemanticStale(projectId)).toBe(1);
    expect(db.listSemanticStalePaths(projectId)).toEqual([FULL_FILE.path]);
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

  it('runs.kind: structural runs are excluded from snapshot-diff pairing', () => {
    const finish = {
      status: 'completed' as const, totalFiles: 1, indexedFiles: 1, skippedFiles: 0,
      errorCount: 0, inputTokens: 0, outputTokens: 0, embeddingTokens: 0, estimatedCostUsd: 0,
    };
    const full1 = db.startRun(projectId, 'p', 'm');
    db.finishRun(full1, finish);
    const structural = db.startRun(projectId, 'tree-sitter', undefined, 'structural');
    db.finishRun(structural, finish);
    const full2 = db.startRun(projectId, 'p', 'm', 'full');
    db.finishRun(full2, finish);

    expect(db.getRun(structural)!.kind).toBe('structural');
    expect(db.getRun(full1)!.kind).toBe('full');
    // started_at is second-granular — assert membership, not order.
    const pair = db.getLastTwoRunIds(projectId)!;
    expect(new Set(pair)).toEqual(new Set([full1, full2]));
  });
});
