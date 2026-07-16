import type { DB } from '../types.js';

export function createBaseTables(db: DB): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS projects (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      root_path TEXT NOT NULL,
      description TEXT,
      provider TEXT,
      model TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      last_indexed TEXT,
      structural_last_checked_at TEXT,
      file_count INTEGER NOT NULL DEFAULT 0,
      symbol_count INTEGER NOT NULL DEFAULT 0,
      index_ignore_patterns TEXT NOT NULL DEFAULT '[]',
      git_remote TEXT,
      default_branch TEXT
    );

    CREATE TABLE IF NOT EXISTS files (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      path TEXT NOT NULL,
      language TEXT NOT NULL DEFAULT 'unknown',
      size INTEGER NOT NULL DEFAULT 0,
      line_count INTEGER NOT NULL DEFAULT 0,
      content_hash TEXT NOT NULL,
      dependencies TEXT NOT NULL DEFAULT '[]',
      internal_deps TEXT NOT NULL DEFAULT '[]',
      external_deps TEXT NOT NULL DEFAULT '[]',
      is_entry_point INTEGER NOT NULL DEFAULT 0,
      is_test INTEGER NOT NULL DEFAULT 0,
      is_generated INTEGER NOT NULL DEFAULT 0,
      index_tier TEXT,
      mapper_reason TEXT,
      mtime_ms INTEGER,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(project_id, path)
    );

    CREATE TABLE IF NOT EXISTS symbols (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
      file_path TEXT NOT NULL,
      name TEXT NOT NULL,
      kind TEXT NOT NULL,
      signature TEXT NOT NULL DEFAULT '',
      parent TEXT,
      modifiers TEXT NOT NULL DEFAULT '[]',
      return_type TEXT,
      parameters TEXT,
      line INTEGER,
      comment TEXT,
      tags TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      started_at TEXT NOT NULL DEFAULT (datetime('now')),
      finished_at TEXT,
      status TEXT NOT NULL DEFAULT 'running',
      total_files INTEGER NOT NULL DEFAULT 0,
      indexed_files INTEGER NOT NULL DEFAULT 0,
      skipped_files INTEGER NOT NULL DEFAULT 0,
      error_count INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      category TEXT NOT NULL DEFAULT 'note',
      content TEXT NOT NULL DEFAULT '',
      tags TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      created_by TEXT NOT NULL DEFAULT 'manual'
    );

    CREATE TABLE IF NOT EXISTS agent_memory (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      scope TEXT NOT NULL DEFAULT 'project',
      project_id INTEGER NOT NULL DEFAULT 0,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      type TEXT NOT NULL DEFAULT 'note',
      content TEXT NOT NULL DEFAULT '',
      source TEXT NOT NULL DEFAULT 'agent',
      source_snapshot_id INTEGER,
      importance REAL NOT NULL DEFAULT 0.5,
      referenced_files TEXT,
      embedding_hash TEXT,
      vector_id TEXT,
      sync INTEGER NOT NULL DEFAULT 1,
      archived_at TEXT,
      archived_reason TEXT,
      superseded_by_id INTEGER,
      last_accessed_at TEXT,
      access_count INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

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

    CREATE TABLE IF NOT EXISTS costs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      run_id INTEGER REFERENCES runs(id) ON DELETE SET NULL,
      provider TEXT NOT NULL,
      model TEXT NOT NULL,
      operation TEXT NOT NULL,
      file_path TEXT,
      input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      cost_usd REAL NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS webhooks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id INTEGER REFERENCES projects(id) ON DELETE CASCADE,
      url TEXT NOT NULL,
      events TEXT NOT NULL DEFAULT '[]',
      secret TEXT,
      active INTEGER NOT NULL DEFAULT 1,
      last_triggered TEXT,
      last_status INTEGER,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS models_cache (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      provider TEXT NOT NULL UNIQUE,
      models TEXT NOT NULL DEFAULT '[]',
      fetched_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS file_dependencies (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      source_file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
      target_file_id INTEGER REFERENCES files(id) ON DELETE SET NULL,
      import_path TEXT NOT NULL,
      dep_type TEXT NOT NULL DEFAULT 'internal'
    );

    CREATE TABLE IF NOT EXISTS symbol_references (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      symbol_id INTEGER REFERENCES symbols(id) ON DELETE SET NULL,
      symbol_name TEXT NOT NULL,
      referencing_file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
      referencing_file_path TEXT NOT NULL,
      line INTEGER,
      context TEXT
    );

    CREATE TABLE IF NOT EXISTS symbol_relations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      symbol_id INTEGER NOT NULL REFERENCES symbols(id) ON DELETE CASCADE,
      related_symbol_name TEXT NOT NULL,
      relation_type TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS snapshot_versions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      snapshot_id INTEGER NOT NULL REFERENCES snapshots(id) ON DELETE CASCADE,
      version INTEGER NOT NULL,
      title TEXT NOT NULL,
      category TEXT NOT NULL,
      content TEXT NOT NULL,
      tags TEXT NOT NULL DEFAULT '[]',
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_by TEXT NOT NULL DEFAULT 'manual'
    );

    CREATE INDEX IF NOT EXISTS idx_files_project ON files(project_id);
    CREATE INDEX IF NOT EXISTS idx_files_project_path ON files(project_id, path);
    CREATE INDEX IF NOT EXISTS idx_files_hash ON files(content_hash);
    CREATE INDEX IF NOT EXISTS idx_files_tier ON files(project_id, index_tier);
    CREATE INDEX IF NOT EXISTS idx_symbols_project ON symbols(project_id);
    CREATE INDEX IF NOT EXISTS idx_symbols_file ON symbols(file_id);
    CREATE INDEX IF NOT EXISTS idx_symbols_name ON symbols(name);
    CREATE INDEX IF NOT EXISTS idx_symbols_kind ON symbols(kind);
    CREATE INDEX IF NOT EXISTS idx_symbols_parent ON symbols(parent);
    CREATE INDEX IF NOT EXISTS idx_runs_project ON runs(project_id);
    CREATE INDEX IF NOT EXISTS idx_snapshots_project ON snapshots(project_id);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_memory_live_name
      ON agent_memory(scope, project_id, name) WHERE archived_at IS NULL;
    CREATE INDEX IF NOT EXISTS idx_agent_memory_scope_project ON agent_memory(scope, project_id, archived_at);
    CREATE INDEX IF NOT EXISTS idx_agent_memory_source_snapshot ON agent_memory(source_snapshot_id);
    CREATE INDEX IF NOT EXISTS idx_agent_memory_type ON agent_memory(type);
    CREATE INDEX IF NOT EXISTS idx_agent_memory_sync ON agent_memory(sync);
    CREATE INDEX IF NOT EXISTS idx_agent_memory_embedding ON agent_memory(embedding_hash);
    CREATE INDEX IF NOT EXISTS idx_agent_memory_events_type ON agent_memory_events(event_type, created_at);
    CREATE INDEX IF NOT EXISTS idx_agent_memory_events_project ON agent_memory_events(project_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_costs_project ON costs(project_id);
    CREATE INDEX IF NOT EXISTS idx_costs_run ON costs(run_id);
    CREATE INDEX IF NOT EXISTS idx_file_deps_source ON file_dependencies(source_file_id);
    CREATE INDEX IF NOT EXISTS idx_file_deps_target ON file_dependencies(target_file_id);
    CREATE INDEX IF NOT EXISTS idx_symbol_refs_name ON symbol_references(symbol_name);
    CREATE INDEX IF NOT EXISTS idx_symbol_refs_file ON symbol_references(referencing_file_id);
    CREATE INDEX IF NOT EXISTS idx_symbol_rels_symbol ON symbol_relations(symbol_id);
    CREATE INDEX IF NOT EXISTS idx_symbol_rels_name ON symbol_relations(related_symbol_name);
    CREATE INDEX IF NOT EXISTS idx_snapshot_versions_snapshot ON snapshot_versions(snapshot_id);
  `);
}
