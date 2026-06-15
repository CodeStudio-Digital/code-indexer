/**
 * Migrations 145 (user-scope memory) + 146 (snapshot archive).
 *
 * NOTE: requires the node-ABI better-sqlite3 build — run `pnpm node:rebuild`
 * with the Electron app closed first, else this fails with ERR_DLOPEN_FAILED.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { CodeIndexDB } from '../../db.js';

describe('migration 145 — user-scope memory', () => {
  let dir: string;
  let db: CodeIndexDB;
  let projectId: number;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'mcp-user-mem-'));
    db = new CodeIndexDB(join(dir, 'test.db'));
    projectId = db.createProject('p', dir).id;
  });
  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('seeds the hidden user project (id 0) and hides it from listProjects', () => {
    expect(db.getProject(0)?.name).toBe('__user__');
    expect(db.listProjects().some((p) => p.id === 0)).toBe(false);
    expect(db.listProjects().some((p) => p.id === projectId)).toBe(true);
  });

  it('derives scope "user" from user/feedback categories', () => {
    const fb = db.createSnapshot(0, { title: 'small files', content: 'under 200 LOC', category: 'feedback' });
    const usr = db.createSnapshot(0, { title: 'about me', content: 'solo dev', category: 'user' });
    expect(db.getSnapshotById(fb.id)?.scope).toBe('user');
    expect(db.getSnapshotById(usr.id)?.scope).toBe('user');
    const proj = db.createSnapshot(projectId, { title: 'x', content: 'y', category: 'decision' });
    expect(db.getSnapshotById(proj.id)?.scope).toBe('project');
  });

  it('keeps user rows out of per-project list/count (project_id isolation)', () => {
    db.createSnapshot(0, { title: 'pref', content: 'c', category: 'feedback' });
    db.createSnapshot(projectId, { title: 'proj', content: 'c', category: 'decision' });
    expect(db.listSnapshots(projectId).map((s) => s.title)).toEqual(['proj']);
    expect(db.countSnapshots(projectId)).toBe(1);
    expect(db.listSnapshots(0).map((s) => s.title)).toEqual(['pref']);
  });
});

describe('migration 146 — snapshot archive', () => {
  let dir: string;
  let db: CodeIndexDB;
  let projectId: number;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'mcp-snap-archive-'));
    db = new CodeIndexDB(join(dir, 'test.db'));
    projectId = db.createProject('p', dir).id;
  });
  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('hides archived rows from list/count/search and surfaces the archived count', () => {
    const s = db.createSnapshot(projectId, { title: 'JWT auth decision', content: 'use jwt', category: 'decision' });
    expect(db.countSnapshots(projectId)).toBe(1);

    db.archiveSnapshot(s.id, 'stale+cold+low-importance');
    expect(db.countSnapshots(projectId)).toBe(0);
    expect(db.listSnapshots(projectId)).toHaveLength(0);
    expect(db.searchSnapshots(projectId, 'jwt')).toHaveLength(0);
    expect(db.countArchivedSnapshots(projectId)).toBe(1);
    // getSnapshotById still returns it (needed for restore/admin).
    expect(db.getSnapshotById(s.id)?.archived_at).toBeTruthy();
  });

  it('restores an archived row and clears its embedding hash for re-embed', () => {
    const s = db.createSnapshot(projectId, { title: 't', content: 'c', category: 'note' });
    db.updateSnapshotEmbeddingHash(s.id, 'abc123');
    db.archiveSnapshot(s.id, 'merged:99');
    db.unarchiveSnapshot(s.id);

    const restored = db.getSnapshotById(s.id);
    expect(restored?.archived_at == null).toBe(true);
    expect(restored?.embedding_hash).toBeNull();
    expect(db.countSnapshots(projectId)).toBe(1);
  });
});
