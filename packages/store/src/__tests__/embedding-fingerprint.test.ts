/**
 * Migration 113 + the re-index-on-model-change primitives: per-project
 * embedding fingerprint storage and clearEmbeddingHashes. The IndexAgent uses
 * these to force a full re-embed when the embedding model/backend changes.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { CodeIndexDB } from '../db.js';

describe('embedding fingerprint + clearEmbeddingHashes (migration 113)', () => {
  let dir: string;
  let db: CodeIndexDB;
  let projectId: number;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'mcp-emb-fp-'));
    db = new CodeIndexDB(join(dir, 'test.db'));
    projectId = db.createProject('p', dir).id;
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('stores and reads the per-project embedding fingerprint', () => {
    expect(db.getProjectEmbeddingFingerprint(projectId)).toBeNull();
    db.setProjectEmbeddingFingerprint(projectId, 'local:Xenova/multilingual-e5-small');
    expect(db.getProjectEmbeddingFingerprint(projectId)).toBe('local:Xenova/multilingual-e5-small');
    // Overwrite (model switch).
    db.setProjectEmbeddingFingerprint(projectId, 'cloudflare:bge-m3');
    expect(db.getProjectEmbeddingFingerprint(projectId)).toBe('cloudflare:bge-m3');
  });

  it('clearEmbeddingHashes nulls the embedding hash (snapshot path)', () => {
    // files/symbols clear via the identical `UPDATE ... SET embedding_hash =
    // NULL WHERE project_id = ?` statement; snapshot is the cheap-to-set case.
    const snap = db.createSnapshot(projectId, { title: 't', category: 'note', content: 'c' });
    db.updateSnapshotEmbeddingHash(snap.id, 'sh');
    expect(db.getSnapshotById(snap.id)!.embedding_hash).toBe('sh');

    db.clearEmbeddingHashes(projectId);
    expect(db.getSnapshotById(snap.id)!.embedding_hash).toBeNull();
  });
});
