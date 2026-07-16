import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import type DatabaseConstructor from 'better-sqlite3';
import { CENTRAL_DROP_TABLES } from '../../project-db/trim/drop-list.js';
import { investigationEmbeddingFingerprint228 } from '../228_investigation_embedding_fingerprint.js';

type DB = InstanceType<typeof DatabaseConstructor>;
let db: DB;

function columns(table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>)
    .map((row) => row.name);
}

beforeEach(() => { db = new Database(':memory:'); });
afterEach(() => db.close());

describe('migration 228 — investigation embedding fingerprint', () => {
  it('no-ops on an already-trimmed project database', () => {
    expect(() => investigationEmbeddingFingerprint228.up(db)).not.toThrow();
    const table = db.prepare(
      `SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'coder_investigations'`,
    ).get();
    expect(table).toBeUndefined();
  });

  it('upgrades a central database idempotently and leaves legacy vectors unscoped', () => {
    db.exec(`
      CREATE TABLE coder_investigations (
        id INTEGER PRIMARY KEY,
        embedding BLOB
      );
      INSERT INTO coder_investigations (id, embedding) VALUES (1, X'00000000');
    `);

    investigationEmbeddingFingerprint228.up(db);
    investigationEmbeddingFingerprint228.up(db);

    expect(columns('coder_investigations').filter((name) => name === 'embedding_fingerprint')).toHaveLength(1);
    const row = db.prepare(
      'SELECT embedding_fingerprint FROM coder_investigations WHERE id = 1',
    ).get() as { embedding_fingerprint: string | null };
    expect(row.embedding_fingerprint).toBeNull();
    const index = db.prepare(
      `SELECT 1 FROM sqlite_master WHERE type = 'index'
       AND name = 'idx_coder_investigations_embedding_fingerprint'`,
    ).get();
    expect(index).toBeDefined();
  });

  it('keeps coder_investigations classified as central-only', () => {
    expect(CENTRAL_DROP_TABLES).toContain('coder_investigations');
  });
});
