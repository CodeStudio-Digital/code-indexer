import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { removeCodeLlmIndex232 } from '../232_remove_code_llm_index.js';

describe('migration 232 — remove code LLM index', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.exec(`
      CREATE TABLE files (
        id INTEGER PRIMARY KEY,
        project_id INTEGER NOT NULL,
        path TEXT NOT NULL,
        language TEXT NOT NULL,
        size INTEGER NOT NULL,
        line_count INTEGER NOT NULL,
        content_hash TEXT NOT NULL,
        summary TEXT NOT NULL DEFAULT '',
        concepts TEXT NOT NULL DEFAULT '[]',
        dependencies TEXT NOT NULL DEFAULT '[]',
        internal_deps TEXT NOT NULL DEFAULT '[]',
        external_deps TEXT NOT NULL DEFAULT '[]',
        notes TEXT NOT NULL DEFAULT '[]',
        complexity TEXT NOT NULL DEFAULT 'low',
        layer TEXT NOT NULL DEFAULT 'unknown',
        is_entry_point INTEGER NOT NULL DEFAULT 0,
        is_test INTEGER NOT NULL DEFAULT 0,
        is_generated INTEGER NOT NULL DEFAULT 0,
        index_tier TEXT,
        mapper_reason TEXT,
        mtime_ms INTEGER,
        embedding_hash TEXT,
        structure_hash TEXT,
        structure_embedding BLOB,
        semantic_hash TEXT,
        created_at TEXT,
        updated_at TEXT
      );
      CREATE TABLE symbols (
        id INTEGER PRIMARY KEY,
        file_id INTEGER,
        embedding_hash TEXT,
        body_embedding_hash TEXT
      );
      CREATE TABLE file_concepts (id INTEGER PRIMARY KEY, file_id INTEGER, concept TEXT);
      CREATE TABLE file_snapshots (id INTEGER PRIMARY KEY, run_id INTEGER, summary TEXT, concepts TEXT);
      CREATE TABLE runs (
        id INTEGER PRIMARY KEY,
        project_id INTEGER NOT NULL,
        started_at TEXT,
        finished_at TEXT,
        status TEXT NOT NULL DEFAULT 'running',
        total_files INTEGER NOT NULL DEFAULT 0,
        indexed_files INTEGER NOT NULL DEFAULT 0,
        skipped_files INTEGER NOT NULL DEFAULT 0,
        error_count INTEGER NOT NULL DEFAULT 0,
        provider TEXT,
        model TEXT,
        input_tokens INTEGER NOT NULL DEFAULT 0,
        output_tokens INTEGER NOT NULL DEFAULT 0,
        embedding_tokens INTEGER NOT NULL DEFAULT 0,
        estimated_cost_usd REAL NOT NULL DEFAULT 0,
        phase_timings_json TEXT,
        peak_rss_mb INTEGER,
        kind TEXT NOT NULL DEFAULT 'full'
      );
      CREATE TABLE doc_chunks (id INTEGER PRIMARY KEY, summary TEXT, concepts TEXT);
      CREATE TABLE session_file_baselines (id INTEGER PRIMARY KEY, content TEXT);
      CREATE VIRTUAL TABLE files_fts USING fts5(
        path, summary, concepts, content='files', content_rowid='id'
      );
      CREATE TRIGGER files_ai AFTER INSERT ON files BEGIN
        INSERT INTO files_fts(rowid, path, summary, concepts)
        VALUES (new.id, new.path, new.summary, new.concepts);
      END;
      CREATE TRIGGER files_ad AFTER DELETE ON files BEGIN
        INSERT INTO files_fts(files_fts, rowid, path, summary, concepts)
        VALUES ('delete', old.id, old.path, old.summary, old.concepts);
      END;
      CREATE INDEX idx_files_project_embedding ON files(project_id, embedding_hash);
      CREATE INDEX idx_files_semantic ON files(project_id, semantic_hash);
      CREATE INDEX idx_files_tier ON files(project_id, index_tier);
    `);
    db.exec(`
      INSERT INTO runs (id, project_id, provider, model, kind)
      VALUES (1, 7, 'openai', 'legacy', 'full');
      INSERT INTO runs (id, project_id, provider, model, kind, indexed_files, total_files)
      VALUES (2, 7, 'tree-sitter', NULL, 'structural', 1, 1);
    `);
    db.prepare(`
      INSERT INTO files
        (id, project_id, path, language, size, line_count, content_hash,
         summary, concepts, is_entry_point, is_test, is_generated, index_tier)
      VALUES (1, 7, 'src/server.ts', 'typescript', 100, 5, 'hash',
              'synthetic', '["legacy"]', 1, 0, 0, 'core')
    `).run();
  });

  afterEach(() => db.close());

  it('drops only retired code enrichment and rebuilds path FTS', () => {
    removeCodeLlmIndex232.up(db);
    removeCodeLlmIndex232.up(db);

    const fileColumns = (db.prepare('PRAGMA table_info(files)').all() as Array<{ name: string }>)
      .map((column) => column.name);
    expect(fileColumns).not.toEqual(expect.arrayContaining([
      'summary', 'concepts', 'notes', 'complexity', 'layer', 'semantic_hash',
      'embedding_hash', 'structure_hash', 'structure_embedding',
    ]));
    expect(fileColumns).toEqual(expect.arrayContaining([
      'path', 'dependencies', 'is_entry_point', 'is_test', 'is_generated',
      'index_tier', 'mapper_reason', 'mtime_ms',
    ]));
    expect(db.prepare(`SELECT rowid FROM files_fts WHERE files_fts MATCH 'server'`).all())
      .toEqual([{ rowid: 1 }]);
    expect(db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name IN ('file_concepts','file_snapshots')`).all())
      .toEqual([]);
    expect((db.prepare('PRAGMA table_info(doc_chunks)').all() as Array<{ name: string }>).map((c) => c.name))
      .toEqual(expect.arrayContaining(['summary', 'concepts']));
    expect(db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='session_file_baselines'`).get())
      .toEqual({ name: 'session_file_baselines' });
    expect(db.prepare('SELECT id, indexed_files, total_files FROM runs').all())
      .toEqual([{ id: 2, indexed_files: 1, total_files: 1 }]);
    expect((db.prepare('PRAGMA table_info(runs)').all() as Array<{ name: string }>).map((c) => c.name))
      .not.toEqual(expect.arrayContaining([
        'provider', 'model', 'input_tokens', 'output_tokens', 'embedding_tokens',
        'estimated_cost_usd', 'phase_timings_json', 'peak_rss_mb', 'kind',
      ]));
  });
});
