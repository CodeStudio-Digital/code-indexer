/**
 * Migration 114 — snapshot memory fields (source / importance / access).
 * Pins the column defaults and that createSnapshot persists explicit values.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { CodeIndexDB } from '../../db.js';

describe('migration 114 — snapshot memory fields', () => {
  let dir: string;
  let db: CodeIndexDB;
  let projectId: number;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'mcp-snap-mem-'));
    db = new CodeIndexDB(join(dir, 'test.db'));
    projectId = db.createProject('p', dir).id;
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('defaults source=manual, importance=0.5, access_count=0', () => {
    const snap = db.createSnapshot(projectId, { title: 't', category: 'note', content: 'c' });
    const row = db.getSnapshotById(snap.id)!;
    expect(row.source).toBe('manual');
    expect(row.importance).toBe(0.5);
    expect(row.access_count).toBe(0);
    expect(row.last_accessed_at).toBeNull();
  });

  it('persists explicit source + importance', () => {
    const snap = db.createSnapshot(projectId, {
      title: 'd',
      category: 'decision',
      content: 'x',
      source: 'session',
      importance: 0.9,
    });
    const row = db.getSnapshotById(snap.id)!;
    expect(row.source).toBe('session');
    expect(row.importance).toBe(0.9);
  });
});
