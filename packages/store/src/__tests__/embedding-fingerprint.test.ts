/**
 * Migration 113 + the re-index-on-model-change primitives: per-project
 * embedding fingerprint storage. semantic_items source hashes include this
 * fingerprint, so model changes no longer mutate structural hash columns.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { CodeIndexDB } from '../db.js';

describe('embedding fingerprint (migration 113 compatibility)', () => {
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
});
