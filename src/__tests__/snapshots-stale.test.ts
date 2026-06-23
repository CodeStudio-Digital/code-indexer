import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { CodeIndexDB } from '@mcp/store/db.js';
import { SnapshotService } from '@mcp/services/services/snapshots.js';

function mkFileData(path: string, hash: string) {
  return {
    path,
    language: 'typescript',
    size: 10,
    lineCount: 5,
    contentHash: hash,
    summary: '',
    concepts: [],
    dependencies: [],
    internalDeps: [],
    externalDeps: [],
    notes: [],
    complexity: 'low',
  };
}

describe('Snapshot staleness', () => {
  let dir: string;
  let db: CodeIndexDB;
  let svc: SnapshotService;
  let projectId: number;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'mcp-snap-stale-'));
    db = new CodeIndexDB(join(dir, 'test.db'));
    svc = new SnapshotService(db);
    const p = db.createProject('p', dir);
    projectId = p.id;
    db.upsertFile(projectId, mkFileData('src/a.ts', 'hash-v1'));
    db.upsertFile(projectId, mkFileData('src/b.ts', 'hash-v1'));
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('snapshot with no referenced files is never stale', async () => {
    const { snap } = await svc.create(projectId, {
      title: 'Arch decision',
      category: 'decision',
      content: 'Use event sourcing',
    });
    const annotated = svc.annotateStale(projectId, snap);
    expect(annotated.stale).toBeUndefined();
    expect(annotated.stale_files).toBeUndefined();
  });

  it('snapshot is not stale when referenced files are unchanged', async () => {
    const { snap } = await svc.create(projectId, {
      title: 'Uses src/a.ts',
      category: 'note',
      content: 'Refers to a.ts',
      referencedFiles: ['src/a.ts'],
    });
    const annotated = svc.annotateStale(projectId, snap);
    expect(annotated.stale).toBeUndefined();
  });

  it('snapshot becomes stale when a referenced file changes', async () => {
    const { snap } = await svc.create(projectId, {
      title: 'Uses src/a.ts',
      category: 'note',
      content: 'Refers to a.ts',
      referencedFiles: ['src/a.ts'],
    });
    // Simulate reindex with new hash
    db.upsertFile(projectId, mkFileData('src/a.ts', 'hash-v2'));
    const annotated = svc.annotateStale(projectId, snap);
    expect(annotated.stale).toBe(true);
    expect(annotated.stale_files).toEqual(['src/a.ts']);
  });

  it('partial staleness lists only divergent files', async () => {
    const { snap } = await svc.create(projectId, {
      title: 'Uses a and b',
      category: 'note',
      content: 'Refers to both',
      referencedFiles: ['src/a.ts', 'src/b.ts'],
    });
    db.upsertFile(projectId, mkFileData('src/b.ts', 'hash-v2'));
    const annotated = svc.annotateStale(projectId, snap);
    expect(annotated.stale).toBe(true);
    expect(annotated.stale_files).toEqual(['src/b.ts']);
  });

  it('files that disappear from the index count as stale', async () => {
    const { snap } = await svc.create(projectId, {
      title: 'Uses a',
      category: 'note',
      content: 'Refers to a.ts',
      referencedFiles: ['src/a.ts'],
    });
    // Remove the file row entirely
    db['db'].prepare('DELETE FROM files WHERE project_id = ? AND path = ?').run(
      projectId,
      'src/a.ts'
    );
    const annotated = svc.annotateStale(projectId, snap);
    expect(annotated.stale).toBe(true);
    expect(annotated.stale_files).toEqual(['src/a.ts']);
  });

  it('referenced files not yet indexed are reported as skipped', async () => {
    const { skippedFiles } = await svc.create(projectId, {
      title: 'Refs unindexed',
      category: 'note',
      content: 'Should warn',
      referencedFiles: ['src/a.ts', 'src/never-indexed.ts'],
    });
    expect(skippedFiles).toEqual(['src/never-indexed.ts']);
  });
});
