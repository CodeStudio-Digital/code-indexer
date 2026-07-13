import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import type DatabaseConstructor from 'better-sqlite3';
import { docIngestGenerations214 } from '../214_doc_ingest_generations.js';
import { docRagTelemetryCache215 } from '../215_doc_rag_telemetry_cache.js';
import { docIngestPauseWorkers216 } from '../216_doc_ingest_pause_workers.js';

type DB = InstanceType<typeof DatabaseConstructor>;
let db: DB;

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE doc_sources (id INTEGER PRIMARY KEY, enrichment_mode TEXT);
    CREATE TABLE doc_chunks (
      id INTEGER PRIMARY KEY,
      source_id INTEGER NOT NULL REFERENCES doc_sources(id) ON DELETE CASCADE
    );
  `);
});
afterEach(() => db.close());

function columns(table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((r) => r.name);
}

describe('migrations 214/215 — resumable documentation ingestion', () => {
  it('adds stable generations, manifests and run checkpoints idempotently', () => {
    docIngestGenerations214.up(db);
    docIngestGenerations214.up(db);
    expect(columns('doc_sources')).toEqual(expect.arrayContaining(['enrichment_mode', 'embedding_fingerprint', 'last_ingest_run_id']));
    expect(columns('doc_chunks')).toEqual(expect.arrayContaining(['stable_key', 'item_key', 'ingest_run_id', 'embedding_input_hash', 'embedding_fingerprint']));
    expect(columns('doc_ingest_runs')).toContain('heartbeat_at');
    expect(columns('doc_source_items')).toEqual(expect.arrayContaining(['item_key', 'mtime_ms', 'content_hash', 'last_seen_run_id']));
  });

  it('creates enrichment cache and search telemetry idempotently', () => {
    docRagTelemetryCache215.up(db);
    docRagTelemetryCache215.up(db);
    expect(columns('doc_enrichment_cache')).toEqual(expect.arrayContaining(['content_hash', 'fingerprint', 'concepts_json']));
    expect(columns('doc_search_events')).toEqual(expect.arrayContaining(['query_hash', 'fts_hits', 'vector_hits', 'stale_vector_hits']));
  });

  it('remains a no-op for trimmed databases without documentation tables', () => {
    db.exec('DROP TABLE doc_chunks; DROP TABLE doc_sources;');
    expect(() => docIngestGenerations214.up(db)).not.toThrow();
    expect(() => docRagTelemetryCache215.up(db)).not.toThrow();
  });

  it('upgrades active runs for pause/resume and preserves manifest foreign keys', () => {
    docIngestGenerations214.up(db);
    db.prepare(`INSERT INTO doc_sources(id,enrichment_mode) VALUES (1,'selective')`).run();
    const runId = db.prepare(`INSERT INTO doc_ingest_runs(source_id,processed_items) VALUES (1,7)`).run().lastInsertRowid;
    db.prepare(`INSERT INTO doc_source_items(source_id,item_key,last_seen_run_id) VALUES (1,'A.html',?)`).run(runId);

    docIngestPauseWorkers216.up(db);

    expect(columns('doc_ingest_runs')).toEqual(expect.arrayContaining([
      'pause_requested', 'performance_profile', 'worker_count',
    ]));
    expect(columns('doc_sources')).toEqual(expect.arrayContaining([
      'folder_performance_profile', 'folder_worker_count',
    ]));
    expect((db.prepare(`SELECT processed_items FROM doc_ingest_runs WHERE id=?`).get(runId) as { processed_items: number }).processed_items).toBe(7);
    expect(() => db.prepare(`UPDATE doc_ingest_runs SET state='paused' WHERE id=?`).run(runId)).not.toThrow();
    expect(db.pragma('foreign_key_check')).toEqual([]);
  });
});
