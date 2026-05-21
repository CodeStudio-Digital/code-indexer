/**
 * Coverage for DocsResearchSessionsStore — CRUD over docs_research_sessions
 * (migration 097).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { DocsResearchSessionsStore } from '../session-store/docs-research-sessions-store.js';

function makeDb(): Database.Database {
  const db = new Database(':memory:');
  // Inline the migration 097 schema — keeps tests self-contained and
  // independent of migration ordering.
  db.exec(`
    CREATE TABLE IF NOT EXISTS docs_research_sessions (
      id                       INTEGER PRIMARY KEY AUTOINCREMENT,
      triggered_by             TEXT NOT NULL CHECK(triggered_by IN ('user','coder')),
      parent_coder_session_id  INTEGER,
      query                    TEXT NOT NULL,
      collections_json         TEXT,
      status                   TEXT NOT NULL DEFAULT 'running'
                                 CHECK(status IN ('running','completed','failed','aborted')),
      num_turns                INTEGER NOT NULL DEFAULT 0,
      num_searches             INTEGER NOT NULL DEFAULT 0,
      num_chunks_read          INTEGER NOT NULL DEFAULT 0,
      query_rewrites_used      INTEGER NOT NULL DEFAULT 0,
      reranks_used             INTEGER NOT NULL DEFAULT 0,
      final_markdown           TEXT,
      final_chunk_ids_json     TEXT,
      confidence               TEXT CHECK(confidence IN ('high','medium','low') OR confidence IS NULL),
      error_message            TEXT,
      input_tokens             INTEGER NOT NULL DEFAULT 0,
      output_tokens            INTEGER NOT NULL DEFAULT 0,
      cost_usd                 REAL NOT NULL DEFAULT 0,
      started_at               TEXT NOT NULL DEFAULT (datetime('now')),
      completed_at             TEXT
    );
  `);
  return db;
}

let db: Database.Database;
let store: DocsResearchSessionsStore;

beforeEach(() => {
  db = makeDb();
  store = new DocsResearchSessionsStore(db);
});

describe('DocsResearchSessionsStore.create', () => {
  it('inserts a row with default running status and returns its id', () => {
    const id = store.create({
      triggered_by: 'user',
      query: 'how to use OAuth in Next.js 15',
    });
    expect(id).toBeGreaterThan(0);
    const row = store.get(id);
    expect(row).not.toBeNull();
    expect(row!.status).toBe('running');
    expect(row!.query).toBe('how to use OAuth in Next.js 15');
    expect(row!.triggered_by).toBe('user');
    expect(row!.parent_coder_session_id).toBeNull();
    expect(row!.collections_json).toBeNull();
  });

  it('persists collections as JSON when provided', () => {
    const id = store.create({
      triggered_by: 'coder',
      parent_coder_session_id: 42,
      query: 'q',
      collections: ['nextjs-docs', 'next-auth-docs'],
    });
    const row = store.get(id)!;
    expect(row.parent_coder_session_id).toBe(42);
    expect(JSON.parse(row.collections_json!)).toEqual(['nextjs-docs', 'next-auth-docs']);
  });
});

describe('DocsResearchSessionsStore.complete', () => {
  it('marks a session completed and persists telemetry + final fields', () => {
    const id = store.create({ triggered_by: 'user', query: 'q' });
    store.complete(id, {
      status: 'completed',
      num_turns: 4,
      num_searches: 2,
      num_chunks_read: 5,
      query_rewrites_used: 1,
      reranks_used: 1,
      final_markdown: '# Answer\n\nSee [^1].',
      final_chunk_ids: [101, 202],
      confidence: 'high',
      input_tokens: 1234,
      output_tokens: 567,
      cost_usd: 0.018,
    });
    const row = store.get(id)!;
    expect(row.status).toBe('completed');
    expect(row.num_turns).toBe(4);
    expect(row.num_searches).toBe(2);
    expect(row.num_chunks_read).toBe(5);
    expect(row.query_rewrites_used).toBe(1);
    expect(row.reranks_used).toBe(1);
    expect(row.final_markdown).toContain('Answer');
    expect(JSON.parse(row.final_chunk_ids_json!)).toEqual([101, 202]);
    expect(row.confidence).toBe('high');
    expect(row.input_tokens).toBe(1234);
    expect(row.output_tokens).toBe(567);
    expect(row.cost_usd).toBeCloseTo(0.018);
    expect(row.completed_at).toBeTruthy();
  });

  it('preserves an error_message on failed sessions', () => {
    const id = store.create({ triggered_by: 'user', query: 'q' });
    store.complete(id, {
      status: 'failed',
      num_turns: 0,
      num_searches: 0,
      num_chunks_read: 0,
      query_rewrites_used: 0,
      reranks_used: 0,
      final_markdown: null,
      final_chunk_ids: [],
      confidence: null,
      error_message: 'No binding configured',
      input_tokens: 0,
      output_tokens: 0,
      cost_usd: 0,
    });
    const row = store.get(id)!;
    expect(row.status).toBe('failed');
    expect(row.error_message).toBe('No binding configured');
    expect(row.final_markdown).toBeNull();
    expect(row.final_chunk_ids_json).toBeNull();
    expect(row.confidence).toBeNull();
  });
});

describe('DocsResearchSessionsStore.list', () => {
  it('returns sessions ordered newest first with limit', () => {
    const id1 = store.create({ triggered_by: 'user', query: 'q1' });
    const id2 = store.create({ triggered_by: 'user', query: 'q2' });
    const id3 = store.create({ triggered_by: 'user', query: 'q3' });
    const all = store.list();
    // Newest id (highest) should be first (started_at ties broken by id DESC).
    expect(all.map((s) => s.id)).toEqual([id3, id2, id1]);
    const onlyOne = store.list({ limit: 1 });
    expect(onlyOne).toHaveLength(1);
    expect(onlyOne[0]!.id).toBe(id3);
  });

  it('filters by parent_coder_session_id', () => {
    store.create({ triggered_by: 'user', query: 'unrelated' });
    const own = store.create({
      triggered_by: 'coder',
      parent_coder_session_id: 42,
      query: 'coder-specific',
    });
    const list = store.list({ parentCoderSessionId: 42 });
    expect(list).toHaveLength(1);
    expect(list[0]!.id).toBe(own);
  });

  it('filters by status', () => {
    const id = store.create({ triggered_by: 'user', query: 'q' });
    // Leave running.
    const completedId = store.create({ triggered_by: 'user', query: 'done' });
    store.complete(completedId, {
      status: 'completed',
      num_turns: 1,
      num_searches: 0,
      num_chunks_read: 0,
      query_rewrites_used: 0,
      reranks_used: 0,
      final_markdown: 'ok',
      final_chunk_ids: [],
      confidence: 'low',
      input_tokens: 0,
      output_tokens: 0,
      cost_usd: 0,
    });
    const running = store.list({ status: 'running' });
    expect(running.map((s) => s.id)).toEqual([id]);
    const completed = store.list({ status: 'completed' });
    expect(completed.map((s) => s.id)).toEqual([completedId]);
  });
});

describe('DocsResearchSessionsStore.delete', () => {
  it('returns true when the row was removed', () => {
    const id = store.create({ triggered_by: 'user', query: 'q' });
    expect(store.delete(id)).toBe(true);
    expect(store.get(id)).toBeNull();
  });

  it('returns false for missing ids', () => {
    expect(store.delete(99999)).toBe(false);
  });
});
