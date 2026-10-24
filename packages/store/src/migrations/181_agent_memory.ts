/**
 * Migration 181 — dedicated `agent_memory` store.
 *
 * Until now durable agent memory was implemented ON TOP OF the `snapshots`
 * table (migrations 114/145/146): snapshots doubled as "project memory". That
 * conflated two different concepts — curated/indexed context (snapshots) vs.
 * single-fact durable learnings the agent writes for future sessions (memory).
 * This migration gives Agent Memory its OWN table, separate from snapshots,
 * with FTS5 search, scope separation (project/user/local), logical-immutable
 * archive/supersede, access counters, an optional sync flag (entitlement-gated
 * at the cloud layer) and a lightweight events table for telemetry.
 *
 * Snapshots are left untouched — they keep serving indexing/context/review.
 * The non-destructive snapshot→agent_memory migration is a separate script.
 *
 * Invariants preserved from the Claude-style memory design as SCHEMA/BEHAVIOUR:
 *   - single fact per memory (`content`), with a logical frontmatter
 *     (`name`/`description`/`type`/`scope`/`created`);
 *   - one live row per (scope, project_id, name) — unique partial index;
 *   - logical immutability — never edit in place; `replace` = archive + create;
 *   - stale-check lives in the retriever (referenced_files).
 *
 * `agent_memory` is a CENTRAL table (project_id FK like snapshots). On a
 * per-project DB the central lineage still runs but trims tables away, so every
 * statement is guarded / `IF NOT EXISTS`.
 */
import type DatabaseConstructor from 'better-sqlite3';
import type { Migration } from './types.js';

type DB = InstanceType<typeof DatabaseConstructor>;

function tableExists(db: DB, table: string): boolean {
  return !!db
    .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`)
    .get(table);
}

export const agentMemory181: Migration = {
  version: 181,
  name: 'agent_memory',
  up: (db: DB): void => {
    // `projects` is a central table; if it was trimmed away on a per-project DB
    // there is nothing to attach memory to — skip the whole migration.
    if (!tableExists(db, 'projects')) return;

    db.exec(`
      CREATE TABLE IF NOT EXISTS agent_memory (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        -- 'project' | 'user' | 'local'. user/local rows use project_id 0.
        scope TEXT NOT NULL DEFAULT 'project',
        -- 0 for user/global memory; a real project id otherwise. No FK CASCADE:
        -- archiving is logical and project deletion is handled explicitly so a
        -- dropped project never silently nukes user-scope rows (project_id 0).
        project_id INTEGER NOT NULL DEFAULT 0,
        -- kebab-case slug derived from the title; the stable identity key.
        name TEXT NOT NULL,
        -- one-line summary (logical frontmatter).
        description TEXT NOT NULL DEFAULT '',
        -- closed taxonomy: preference | convention | procedure | architecture |
        -- gotcha | external_pointer | pattern | decision | note.
        type TEXT NOT NULL DEFAULT 'note',
        -- the single durable fact (one paragraph).
        content TEXT NOT NULL DEFAULT '',
        -- provenance: agent | user | distill | migrated-snapshot | ...
        source TEXT NOT NULL DEFAULT 'agent',
        -- when migrated from a legacy snapshot, its id (idempotency key).
        source_snapshot_id INTEGER,
        -- 0..1 salience.
        importance REAL NOT NULL DEFAULT 0.5,
        -- JSON array of project-relative paths this memory depends on (staleness).
        referenced_files TEXT,
        -- hash(content + embedding fingerprint); NULL ⇒ needs (re)embedding.
        embedding_hash TEXT,
        -- opaque vector id for lifecycle cleanup; NULL ⇒ no vector yet.
        vector_id TEXT,
        -- sync intent (cloud push). Default per scope: local never syncs.
        -- The actual push is entitlement-gated at the cloud-api layer.
        sync INTEGER NOT NULL DEFAULT 1,
        -- logical-immutable lifecycle.
        archived_at TEXT,
        archived_reason TEXT,
        superseded_by_id INTEGER,
        -- usage signal.
        last_accessed_at TEXT,
        access_count INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);

    // local scope never syncs — enforce the default at the column level for
    // rows that don't pass sync explicitly.
    db.exec(`
      CREATE TRIGGER IF NOT EXISTS agent_memory_local_no_sync
      AFTER INSERT ON agent_memory
      WHEN new.scope = 'local' AND new.sync <> 0
      BEGIN
        UPDATE agent_memory SET sync = 0 WHERE id = new.id;
      END;
    `);

    // One LIVE row per (scope, project_id, name). Archived rows are excluded so
    // archive + recreate-same-name works (logical immutability).
    db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_memory_live_name
        ON agent_memory(scope, project_id, name) WHERE archived_at IS NULL;
      CREATE INDEX IF NOT EXISTS idx_agent_memory_scope_project
        ON agent_memory(scope, project_id, archived_at);
      CREATE INDEX IF NOT EXISTS idx_agent_memory_source_snapshot
        ON agent_memory(source_snapshot_id);
      CREATE INDEX IF NOT EXISTS idx_agent_memory_type ON agent_memory(type);
      CREATE INDEX IF NOT EXISTS idx_agent_memory_sync ON agent_memory(sync);
      CREATE INDEX IF NOT EXISTS idx_agent_memory_embedding
        ON agent_memory(embedding_hash);
    `);

    // FTS5 over the searchable text. External-content table mirrors the
    // snapshots_fts pattern; triggers keep it in sync. Updates re-sync via
    // delete+insert in the store layer (matches snapshots.update).
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS agent_memory_fts USING fts5(
        name, description, content,
        content='agent_memory', content_rowid='id',
        tokenize='unicode61 remove_diacritics 2'
      );

      CREATE TRIGGER IF NOT EXISTS agent_memory_ai AFTER INSERT ON agent_memory BEGIN
        INSERT INTO agent_memory_fts(rowid, name, description, content)
        VALUES (new.id, new.name, new.description, new.content);
      END;

      CREATE TRIGGER IF NOT EXISTS agent_memory_ad AFTER DELETE ON agent_memory BEGIN
        INSERT INTO agent_memory_fts(agent_memory_fts, rowid, name, description, content)
        VALUES ('delete', old.id, old.name, old.description, old.content);
      END;
    `);

    // Lightweight telemetry — proves memory left dormancy. Written async/sampled
    // by the store layer; pruned by the sweeper (retention).
    db.exec(`
      CREATE TABLE IF NOT EXISTS agent_memory_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        event_type TEXT NOT NULL,
        scope TEXT,
        project_id INTEGER,
        memory_id INTEGER,
        session_id INTEGER,
        kept INTEGER,
        dropped INTEGER,
        query_hash TEXT,
        meta_json TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_agent_memory_events_type
        ON agent_memory_events(event_type, created_at);
      CREATE INDEX IF NOT EXISTS idx_agent_memory_events_project
        ON agent_memory_events(project_id, created_at);
    `);
  },
};
