import { createRequire } from 'node:module';
import { dirname, basename, join } from 'node:path';
import type DatabaseConstructor from 'better-sqlite3';
import { runMigrations, getSchemaVersion } from './migrations/index.js';
import { computeStableId } from './migrations/002_symbol_stable_id.js';
import type {
  Project,
  DBFile,
  DBSymbol,
  IndexRun,
  CostRecord,
  CostSummary,
  ContextSnapshot,
  Webhook,
  FileSnapshot,
  VectorIdRecord,
  ProjectStats,
  DiscoveredModel,
  SnapshotCategory,
  SnapshotVersion,
  RunStatus,
  LLMSymbol,
  DBFileDependency,
  DBFileDependent,
  DBSymbolReference,
  DBSymbolRelation,
} from '../types.js';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3') as typeof DatabaseConstructor;

type DB = InstanceType<typeof Database>;

/**
 * Read tsconfig `compilerOptions.paths` aliases from a project root, if present.
 * Returns a list of `{ prefix, targets }` where prefix is the alias without
 * trailing `*` and targets are project-relative replacement paths.
 *
 * Tolerates JSONC (strips `//` and `/* *\/` comments) because tsconfig.json
 * commonly has comments. Silently returns `[]` when the file or field is
 * missing or unreadable — the resolver falls back to the relative-path logic.
 */
interface PathAlias {
  prefix: string; // e.g. "@app/"
  targets: string[]; // e.g. ["src/"]
}

function loadTsconfigPathAliases(projectRoot: string): PathAlias[] {
  const fs = require('node:fs') as typeof import('node:fs');
  const path = require('node:path') as typeof import('node:path');
  const candidates = ['tsconfig.json', 'jsconfig.json'];
  for (const fname of candidates) {
    const p = path.join(projectRoot, fname);
    if (!fs.existsSync(p)) continue;
    try {
      const raw = fs.readFileSync(p, 'utf-8');
      // Strip line and block comments (JSONC) before parsing.
      const stripped = raw
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '');
      const parsed = JSON.parse(stripped);
      const paths = parsed?.compilerOptions?.paths;
      const baseUrl: string = parsed?.compilerOptions?.baseUrl ?? '.';
      if (!paths || typeof paths !== 'object') continue;
      const aliases: PathAlias[] = [];
      for (const [key, value] of Object.entries(paths)) {
        if (!Array.isArray(value)) continue;
        const prefix = key.replace(/\*$/, '');
        const targets = (value as string[]).map((t) => {
          const stripped = t.replace(/\*$/, '');
          // Normalize to project-relative, stripping leading baseUrl if any.
          const joined = path.posix.normalize(
            path.posix.join(baseUrl.replace(/\\/g, '/'), stripped.replace(/\\/g, '/'))
          );
          return joined.replace(/^\.\//, '');
        });
        aliases.push({ prefix, targets });
      }
      return aliases;
    } catch {
      // fall through
    }
  }
  return [];
}

export class CodeIndexDB {
  private db: DB;
  /** Cached tsconfig aliases per project id. Populated lazily. */
  private aliasCache = new Map<number, PathAlias[]>();

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this.db.pragma('cache_size = 10000');
    this.db.pragma('foreign_keys = ON');
    // initSchema() bootstraps fresh DBs via CREATE TABLE IF NOT EXISTS.
    // runMigrations() then applies versioned changes on top of the baseline.
    // Order matters: schema must exist before migrations that ALTER it.
    this.initSchema();
    runMigrations(this.db);
  }

  /** Current schema version (0 if migrations have not run). */
  getSchemaVersion(): number {
    return getSchemaVersion(this.db);
  }

  /**
   * Expose the underlying better-sqlite3 handle for stores that need
   * direct prepared-statement access (e.g. CompanySandboxStore). Avoids
   * re-opening the same file from a second `new Database()` which would
   * cause lock contention and WAL mode confusion.
   */
  raw(): DB {
    return this.db;
  }

  close(): void {
    this.db.close();
  }

  // ─── Schema ──────────────────────────────────────────────────────

  private initSchema(): void {
    this.db.exec(`
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
        file_count INTEGER NOT NULL DEFAULT 0,
        symbol_count INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS files (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        path TEXT NOT NULL,
        language TEXT NOT NULL DEFAULT 'unknown',
        size INTEGER NOT NULL DEFAULT 0,
        line_count INTEGER NOT NULL DEFAULT 0,
        content_hash TEXT NOT NULL,
        summary TEXT NOT NULL DEFAULT '',
        concepts TEXT NOT NULL DEFAULT '[]',
        dependencies TEXT NOT NULL DEFAULT '[]',
        internal_deps TEXT NOT NULL DEFAULT '[]',
        external_deps TEXT NOT NULL DEFAULT '[]',
        notes TEXT NOT NULL DEFAULT '[]',
        complexity TEXT NOT NULL DEFAULT 'low',
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
        error_count INTEGER NOT NULL DEFAULT 0,
        provider TEXT,
        model TEXT,
        input_tokens INTEGER NOT NULL DEFAULT 0,
        output_tokens INTEGER NOT NULL DEFAULT 0,
        embedding_tokens INTEGER NOT NULL DEFAULT 0,
        estimated_cost_usd REAL NOT NULL DEFAULT 0
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

      CREATE TABLE IF NOT EXISTS file_snapshots (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id INTEGER NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
        project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        file_path TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        summary TEXT NOT NULL DEFAULT '',
        concepts TEXT NOT NULL DEFAULT '[]',
        symbols TEXT NOT NULL DEFAULT '[]'
      );

      CREATE TABLE IF NOT EXISTS vector_ids (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        vector_id TEXT NOT NULL,
        file_path TEXT,
        type TEXT NOT NULL DEFAULT 'file',
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS models_cache (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        provider TEXT NOT NULL UNIQUE,
        models TEXT NOT NULL DEFAULT '[]',
        fetched_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS file_concepts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
        concept TEXT NOT NULL
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

      -- Indexes
      CREATE INDEX IF NOT EXISTS idx_files_project ON files(project_id);
      CREATE INDEX IF NOT EXISTS idx_files_project_path ON files(project_id, path);
      CREATE INDEX IF NOT EXISTS idx_files_hash ON files(content_hash);
      CREATE INDEX IF NOT EXISTS idx_symbols_project ON symbols(project_id);
      CREATE INDEX IF NOT EXISTS idx_symbols_file ON symbols(file_id);
      CREATE INDEX IF NOT EXISTS idx_symbols_name ON symbols(name);
      CREATE INDEX IF NOT EXISTS idx_symbols_kind ON symbols(kind);
      CREATE INDEX IF NOT EXISTS idx_symbols_parent ON symbols(parent);
      CREATE INDEX IF NOT EXISTS idx_runs_project ON runs(project_id);
      CREATE INDEX IF NOT EXISTS idx_snapshots_project ON snapshots(project_id);
      CREATE INDEX IF NOT EXISTS idx_costs_project ON costs(project_id);
      CREATE INDEX IF NOT EXISTS idx_costs_run ON costs(run_id);
      CREATE INDEX IF NOT EXISTS idx_file_snapshots_run ON file_snapshots(run_id);
      CREATE INDEX IF NOT EXISTS idx_vector_ids_project ON vector_ids(project_id);

      CREATE INDEX IF NOT EXISTS idx_file_concepts_project_concept ON file_concepts(project_id, concept);
      CREATE INDEX IF NOT EXISTS idx_file_concepts_file ON file_concepts(file_id);
      CREATE INDEX IF NOT EXISTS idx_file_deps_source ON file_dependencies(source_file_id);
      CREATE INDEX IF NOT EXISTS idx_file_deps_target ON file_dependencies(target_file_id);
      CREATE INDEX IF NOT EXISTS idx_symbol_refs_name ON symbol_references(symbol_name);
      CREATE INDEX IF NOT EXISTS idx_symbol_refs_file ON symbol_references(referencing_file_id);
      CREATE INDEX IF NOT EXISTS idx_symbol_rels_symbol ON symbol_relations(symbol_id);
      CREATE INDEX IF NOT EXISTS idx_symbol_rels_name ON symbol_relations(related_symbol_name);
      CREATE INDEX IF NOT EXISTS idx_snapshot_versions_snapshot ON snapshot_versions(snapshot_id);
    `);

    // FTS5 virtual tables
    this.db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS files_fts USING fts5(
        path, summary, concepts, content='files', content_rowid='id',
        tokenize='unicode61 remove_diacritics 2'
      );

      CREATE VIRTUAL TABLE IF NOT EXISTS symbols_fts USING fts5(
        name, kind, signature, comment, tags, file_path, parent,
        content='symbols', content_rowid='id',
        tokenize='unicode61 remove_diacritics 2'
      );
    `);

    // FTS5 sync triggers
    this.db.exec(`
      CREATE TRIGGER IF NOT EXISTS files_ai AFTER INSERT ON files BEGIN
        INSERT INTO files_fts(rowid, path, summary, concepts)
        VALUES (new.id, new.path, new.summary, new.concepts);
      END;

      CREATE TRIGGER IF NOT EXISTS files_ad AFTER DELETE ON files BEGIN
        INSERT INTO files_fts(files_fts, rowid, path, summary, concepts)
        VALUES ('delete', old.id, old.path, old.summary, old.concepts);
      END;

      CREATE TRIGGER IF NOT EXISTS symbols_ai AFTER INSERT ON symbols BEGIN
        INSERT INTO symbols_fts(rowid, name, kind, signature, comment, tags, file_path, parent)
        VALUES (new.id, new.name, new.kind, new.signature, COALESCE(new.comment,''), new.tags, new.file_path, COALESCE(new.parent,''));
      END;

      CREATE TRIGGER IF NOT EXISTS symbols_ad AFTER DELETE ON symbols BEGIN
        INSERT INTO symbols_fts(symbols_fts, rowid, name, kind, signature, comment, tags, file_path, parent)
        VALUES ('delete', old.id, old.name, old.kind, old.signature, COALESCE(old.comment,''), old.tags, old.file_path, COALESCE(old.parent,''));
      END;
    `);

    // Snapshots FTS
    this.db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS snapshots_fts USING fts5(
        title, content, tags,
        content='snapshots', content_rowid='id',
        tokenize='unicode61 remove_diacritics 2'
      );

      CREATE TRIGGER IF NOT EXISTS snapshots_ai AFTER INSERT ON snapshots BEGIN
        INSERT INTO snapshots_fts(rowid, title, content, tags)
        VALUES (new.id, new.title, new.content, new.tags);
      END;

      CREATE TRIGGER IF NOT EXISTS snapshots_ad AFTER DELETE ON snapshots BEGIN
        INSERT INTO snapshots_fts(snapshots_fts, rowid, title, content, tags)
        VALUES ('delete', old.id, old.title, old.content, old.tags);
      END;
    `);

    // Migrations for v3.2 — add columns to existing tables
    try { this.db.exec('SELECT layer FROM files LIMIT 1'); } catch {
      this.db.exec(`
        ALTER TABLE files ADD COLUMN layer TEXT NOT NULL DEFAULT 'unknown';
        ALTER TABLE files ADD COLUMN is_entry_point INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE files ADD COLUMN is_test INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE files ADD COLUMN is_generated INTEGER NOT NULL DEFAULT 0;
      `);
    }

    // Rebuild snapshots FTS for existing data
    try {
      const count = (this.db.prepare('SELECT COUNT(*) as c FROM snapshots_fts').get() as { c: number }).c;
      if (count === 0) {
        const snapCount = (this.db.prepare('SELECT COUNT(*) as c FROM snapshots').get() as { c: number }).c;
        if (snapCount > 0) {
          this.db.exec(`INSERT INTO snapshots_fts(rowid, title, content, tags) SELECT id, title, content, tags FROM snapshots`);
        }
      }
    } catch { /* ignore */ }
  }

  // ─── Projects ───────────────────────────────────────────────────

  createProject(name: string, rootPath: string, description?: string): Project {
    const stmt = this.db.prepare(`
      INSERT INTO projects (name, root_path, description)
      VALUES (?, ?, ?)
    `);
    const result = stmt.run(name, rootPath, description ?? null);
    return this.getProject(result.lastInsertRowid as number)!;
  }

  getProject(id: number): Project | undefined {
    return this.db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as Project | undefined;
  }

  getProjectByName(name: string): Project | undefined {
    return this.db.prepare('SELECT * FROM projects WHERE name = ?').get(name) as Project | undefined;
  }

  getProjectByPath(rootPath: string): Project | undefined {
    const exact = this.db.prepare('SELECT * FROM projects WHERE root_path = ?').get(rootPath) as Project | undefined;
    if (exact) return exact;
    // Try suffix match
    return this.db.prepare("SELECT * FROM projects WHERE root_path LIKE '%' || ?").get(rootPath) as Project | undefined;
  }

  listProjects(): Project[] {
    return this.db.prepare('SELECT * FROM projects ORDER BY name').all() as Project[];
  }

  updateProject(id: number, updates: Partial<Pick<Project, 'name' | 'description' | 'group_name' | 'root_path' | 'provider' | 'model' | 'last_indexed' | 'file_count' | 'symbol_count' | 'embeddings_enabled' | 'search_mode'>>): void {
    const fields: string[] = [];
    const values: unknown[] = [];

    for (const [key, value] of Object.entries(updates)) {
      fields.push(`${key} = ?`);
      values.push(value);
    }

    if (fields.length === 0) return;

    fields.push("updated_at = datetime('now')");
    values.push(id);

    this.db.prepare(`UPDATE projects SET ${fields.join(', ')} WHERE id = ?`).run(...values);
  }

  deleteProject(id: number): void {
    this.db.prepare('DELETE FROM projects WHERE id = ?').run(id);
  }

  resolveProject(name?: string, rootPath?: string): Project {
    if (name) {
      const p = this.getProjectByName(name);
      if (p) return p;
    }
    if (rootPath) {
      const p = this.getProjectByPath(rootPath);
      if (p) return p;
    }

    // Auto-detect from cwd if nothing provided
    const cwd = rootPath ?? process.cwd();
    const existing = this.getProjectByPath(cwd);
    if (existing) return existing;

    // Auto-register with last 2 segments as name
    const parts = cwd.replace(/\\/g, '/').split('/').filter(Boolean);
    const autoName = parts.slice(-2).join('/');
    return this.createProject(name ?? autoName, cwd);
  }

  // ─── Files ──────────────────────────────────────────────────────

  upsertFile(
    projectId: number,
    data: {
      path: string;
      language: string;
      size: number;
      lineCount: number;
      contentHash: string;
      summary: string;
      concepts: string[];
      dependencies: string[];
      internalDeps: string[];
      externalDeps: string[];
      notes: string[];
      complexity: string;
      layer?: string;
      isEntryPoint?: boolean;
      isTest?: boolean;
      isGenerated?: boolean;
    }
  ): number {
    const upsert = this.db.transaction(() => {
      const existing = this.db.prepare(
        'SELECT id, path, summary, concepts FROM files WHERE project_id = ? AND path = ?'
      ).get(projectId, data.path) as { id: number; path: string; summary: string; concepts: string } | undefined;

      let fileId: number;

      if (existing) {
        fileId = existing.id;
        // Delete old FTS entry manually
        this.db.prepare(
          "INSERT INTO files_fts(files_fts, rowid, path, summary, concepts) VALUES ('delete', ?, ?, ?, ?)"
        ).run(existing.id, existing.path, existing.summary, existing.concepts);

        this.db.prepare(`
          UPDATE files SET
            language = ?, size = ?, line_count = ?, content_hash = ?,
            summary = ?, concepts = ?, dependencies = ?,
            internal_deps = ?, external_deps = ?,
            notes = ?, complexity = ?,
            layer = ?, is_entry_point = ?, is_test = ?, is_generated = ?,
            updated_at = datetime('now')
          WHERE id = ?
        `).run(
          data.language, data.size, data.lineCount, data.contentHash,
          data.summary, JSON.stringify(data.concepts), JSON.stringify(data.dependencies),
          JSON.stringify(data.internalDeps), JSON.stringify(data.externalDeps),
          JSON.stringify(data.notes), data.complexity,
          data.layer ?? 'unknown', data.isEntryPoint ? 1 : 0, data.isTest ? 1 : 0, data.isGenerated ? 1 : 0,
          existing.id
        );

        this.db.prepare(
          'INSERT INTO files_fts(rowid, path, summary, concepts) VALUES (?, ?, ?, ?)'
        ).run(existing.id, data.path, data.summary, JSON.stringify(data.concepts));
      } else {
        const result = this.db.prepare(`
          INSERT INTO files (project_id, path, language, size, line_count, content_hash,
            summary, concepts, dependencies, internal_deps, external_deps, notes, complexity,
            layer, is_entry_point, is_test, is_generated)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          projectId, data.path, data.language, data.size, data.lineCount, data.contentHash,
          data.summary, JSON.stringify(data.concepts), JSON.stringify(data.dependencies),
          JSON.stringify(data.internalDeps), JSON.stringify(data.externalDeps),
          JSON.stringify(data.notes), data.complexity,
          data.layer ?? 'unknown', data.isEntryPoint ? 1 : 0, data.isTest ? 1 : 0, data.isGenerated ? 1 : 0
        );
        fileId = result.lastInsertRowid as number;
      }

      // Sync file_concepts
      this.db.prepare('DELETE FROM file_concepts WHERE file_id = ?').run(fileId);
      const insertConcept = this.db.prepare(
        'INSERT INTO file_concepts (project_id, file_id, concept) VALUES (?, ?, ?)'
      );
      for (const concept of data.concepts) {
        insertConcept.run(projectId, fileId, concept);
      }

      return fileId;
    });

    return upsert();
  }

  getFile(projectId: number, path: string): DBFile | undefined {
    return this.db.prepare('SELECT * FROM files WHERE project_id = ? AND path = ?')
      .get(projectId, path) as DBFile | undefined;
  }

  getFileById(id: number): DBFile | undefined {
    return this.db.prepare('SELECT * FROM files WHERE id = ?').get(id) as DBFile | undefined;
  }

  listFiles(projectId: number, language?: string): DBFile[] {
    if (language) {
      return this.db.prepare('SELECT * FROM files WHERE project_id = ? AND language = ? ORDER BY path')
        .all(projectId, language) as DBFile[];
    }
    return this.db.prepare('SELECT * FROM files WHERE project_id = ? ORDER BY path')
      .all(projectId) as DBFile[];
  }

  deleteFile(projectId: number, path: string): void {
    this.db.prepare('DELETE FROM files WHERE project_id = ? AND path = ?').run(projectId, path);
  }

  deleteFilesByProject(projectId: number): void {
    this.db.prepare('DELETE FROM files WHERE project_id = ?').run(projectId);
  }

  searchFiles(projectId: number, query: string, limit: number = 20): DBFile[] {
    return this.db.prepare(`
      SELECT f.* FROM files_fts fts
      JOIN files f ON f.id = fts.rowid
      WHERE fts.files_fts MATCH ? AND f.project_id = ?
      ORDER BY rank
      LIMIT ?
    `).all(query, projectId, limit) as DBFile[];
  }

  // ─── Symbols ────────────────────────────────────────────────────

  upsertSymbols(projectId: number, fileId: number, filePath: string, symbols: LLMSymbol[]): void {
    const upsert = this.db.transaction(() => {
      // Clean up symbol_relations for symbols being replaced
      this.db.prepare('DELETE FROM symbol_relations WHERE symbol_id IN (SELECT id FROM symbols WHERE file_id = ?)').run(fileId);
      // Delete existing symbols for this file (triggers handle FTS cleanup)
      this.db.prepare('DELETE FROM symbols WHERE file_id = ?').run(fileId);

      const insert = this.db.prepare(`
        INSERT INTO symbols (project_id, file_id, file_path, name, kind, signature,
          parent, modifiers, return_type, parameters, line, comment, tags, stable_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      const insertRelation = this.db.prepare(`
        INSERT INTO symbol_relations (project_id, symbol_id, related_symbol_name, relation_type)
        VALUES (?, ?, ?, ?)
      `);

      for (const sym of symbols) {
        const stableId = computeStableId({
          projectId,
          filePath,
          kind: sym.kind,
          parent: sym.parent,
          name: sym.name,
          signature: sym.signature,
        });
        const result = insert.run(
          projectId, fileId, filePath, sym.name, sym.kind, sym.signature,
          sym.parent, JSON.stringify(sym.modifiers), sym.return_type,
          sym.parameters, sym.line, sym.comment, JSON.stringify(sym.tags),
          stableId
        );

        const symId = result.lastInsertRowid as number;

        if (sym.extends_from) {
          insertRelation.run(projectId, symId, sym.extends_from, 'extends');
        }
        if (sym.implements_list && sym.implements_list.length > 0) {
          for (const iface of sym.implements_list) {
            insertRelation.run(projectId, symId, iface, 'implements');
          }
        }
      }
    });

    upsert();
  }

  getSymbolById(id: number): DBSymbol | undefined {
    return this.db.prepare('SELECT * FROM symbols WHERE id = ?').get(id) as DBSymbol | undefined;
  }

  getSymbolsByFile(projectId: number, filePath: string): DBSymbol[] {
    return this.db.prepare('SELECT * FROM symbols WHERE project_id = ? AND file_path = ? ORDER BY line')
      .all(projectId, filePath) as DBSymbol[];
  }

  /**
   * Look up a symbol by its deterministic `stable_id`. Preferred entry
   * point for tools that want to pin to an exact symbol across re-indexes.
   */
  findSymbolByStableId(projectId: number, stableId: string): DBSymbol | undefined {
    return this.db
      .prepare('SELECT * FROM symbols WHERE project_id = ? AND stable_id = ? LIMIT 1')
      .get(projectId, stableId) as DBSymbol | undefined;
  }

  /**
   * Find a single symbol by name, optionally scoped to a file. Returns the first match.
   * Prefer `findSymbolsByName` when ambiguity matters.
   */
  findSymbolByName(
    projectId: number,
    name: string,
    opts?: { filePath?: string; kind?: string }
  ): DBSymbol | undefined {
    const parts = ['project_id = ?', 'name = ?'];
    const params: (string | number)[] = [projectId, name];
    if (opts?.filePath) {
      parts.push('file_path = ?');
      params.push(opts.filePath);
    }
    if (opts?.kind) {
      parts.push('kind = ?');
      params.push(opts.kind);
    }
    const sql = `SELECT * FROM symbols WHERE ${parts.join(' AND ')} LIMIT 1`;
    return this.db.prepare(sql).get(...params) as DBSymbol | undefined;
  }

  /**
   * Find all symbols matching a name in a project (used for disambiguation).
   */
  findSymbolsByName(
    projectId: number,
    name: string,
    opts?: { filePath?: string; kind?: string; limit?: number }
  ): DBSymbol[] {
    const parts = ['project_id = ?', 'name = ?'];
    const params: (string | number)[] = [projectId, name];
    if (opts?.filePath) {
      parts.push('file_path = ?');
      params.push(opts.filePath);
    }
    if (opts?.kind) {
      parts.push('kind = ?');
      params.push(opts.kind);
    }
    const limit = opts?.limit ?? 20;
    const sql = `SELECT * FROM symbols WHERE ${parts.join(' AND ')} ORDER BY file_path, line LIMIT ${limit}`;
    return this.db.prepare(sql).all(...params) as DBSymbol[];
  }

  getClassMembers(parentName: string, projectId: number): DBSymbol[] {
    return this.db.prepare('SELECT * FROM symbols WHERE parent = ? AND project_id = ? ORDER BY line')
      .all(parentName, projectId) as DBSymbol[];
  }

  listAllSymbols(projectId: number): DBSymbol[] {
    return this.db.prepare('SELECT * FROM symbols WHERE project_id = ? ORDER BY name')
      .all(projectId) as DBSymbol[];
  }

  searchSymbols(projectId: number, query: string, limit: number = 20): DBSymbol[] {
    return this.db.prepare(`
      SELECT s.* FROM symbols_fts fts
      JOIN symbols s ON s.id = fts.rowid
      WHERE fts.symbols_fts MATCH ? AND s.project_id = ?
      ORDER BY rank
      LIMIT ?
    `).all(query, projectId, limit) as DBSymbol[];
  }

  // ─── Runs ───────────────────────────────────────────────────────

  startRun(projectId: number, provider?: string, model?: string): number {
    const result = this.db.prepare(`
      INSERT INTO runs (project_id, provider, model)
      VALUES (?, ?, ?)
    `).run(projectId, provider ?? null, model ?? null);
    return result.lastInsertRowid as number;
  }

  finishRun(
    runId: number,
    data: {
      status: RunStatus;
      totalFiles: number;
      indexedFiles: number;
      skippedFiles: number;
      errorCount: number;
      inputTokens: number;
      outputTokens: number;
      embeddingTokens: number;
      estimatedCostUsd: number;
    }
  ): void {
    this.db.prepare(`
      UPDATE runs SET
        finished_at = datetime('now'), status = ?,
        total_files = ?, indexed_files = ?, skipped_files = ?, error_count = ?,
        input_tokens = ?, output_tokens = ?, embedding_tokens = ?, estimated_cost_usd = ?
      WHERE id = ?
    `).run(
      data.status, data.totalFiles, data.indexedFiles, data.skippedFiles, data.errorCount,
      data.inputTokens, data.outputTokens, data.embeddingTokens, data.estimatedCostUsd,
      runId
    );
  }

  getRun(id: number): IndexRun | undefined {
    return this.db.prepare('SELECT * FROM runs WHERE id = ?').get(id) as IndexRun | undefined;
  }

  getRuns(projectId: number, limit: number = 20): IndexRun[] {
    return this.db.prepare('SELECT * FROM runs WHERE project_id = ? ORDER BY started_at DESC LIMIT ?')
      .all(projectId, limit) as IndexRun[];
  }

  // ─── Snapshots ──────────────────────────────────────────────────

  createSnapshot(
    projectId: number,
    data: { title: string; category: SnapshotCategory; content: string; tags?: string[]; createdBy?: string }
  ): ContextSnapshot {
    const result = this.db.prepare(`
      INSERT INTO snapshots (project_id, title, category, content, tags, created_by)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      projectId, data.title, data.category, data.content,
      JSON.stringify(data.tags ?? []), data.createdBy ?? 'manual'
    );
    return this.db.prepare('SELECT * FROM snapshots WHERE id = ?')
      .get(result.lastInsertRowid) as ContextSnapshot;
  }

  /**
   * Record which files a snapshot references, along with each file's
   * current `content_hash`. Used later by `getStaleSnapshotFiles` to
   * detect divergence and flag snapshots as stale.
   *
   * Replaces any existing references for the snapshot (idempotent).
   * Files that are not indexed (no row in `files`) are silently skipped.
   */
  setSnapshotFiles(snapshotId: number, projectId: number, filePaths: string[]): void {
    const tx = this.db.transaction(() => {
      this.db.prepare('DELETE FROM snapshot_files WHERE snapshot_id = ?').run(snapshotId);
      if (filePaths.length === 0) return;
      const getHash = this.db.prepare(
        'SELECT content_hash FROM files WHERE project_id = ? AND path = ?'
      );
      const insert = this.db.prepare(
        'INSERT OR REPLACE INTO snapshot_files (snapshot_id, file_path, file_hash_at_creation) VALUES (?, ?, ?)'
      );
      for (const p of filePaths) {
        const row = getHash.get(projectId, p) as { content_hash: string } | undefined;
        if (row) {
          insert.run(snapshotId, p, row.content_hash);
        }
      }
    });
    tx();
  }

  /**
   * Return the set of referenced files whose current `content_hash`
   * no longer matches the hash recorded when the snapshot was created.
   * Empty array means the snapshot is still in sync (or has no references).
   */
  getStaleSnapshotFiles(snapshotId: number, projectId: number): string[] {
    const rows = this.db.prepare(`
      SELECT sf.file_path, sf.file_hash_at_creation, f.content_hash
      FROM snapshot_files sf
      LEFT JOIN files f ON f.project_id = ? AND f.path = sf.file_path
      WHERE sf.snapshot_id = ?
    `).all(projectId, snapshotId) as {
      file_path: string;
      file_hash_at_creation: string;
      content_hash: string | null;
    }[];
    const stale: string[] = [];
    for (const r of rows) {
      if (r.content_hash === null || r.content_hash !== r.file_hash_at_creation) {
        stale.push(r.file_path);
      }
    }
    return stale;
  }

  /** Return the list of file paths referenced by a snapshot (no staleness check). */
  getSnapshotFiles(snapshotId: number): string[] {
    const rows = this.db.prepare(
      'SELECT file_path FROM snapshot_files WHERE snapshot_id = ? ORDER BY file_path'
    ).all(snapshotId) as { file_path: string }[];
    return rows.map((r) => r.file_path);
  }

  updateSnapshot(id: number, updates: Partial<Pick<ContextSnapshot, 'title' | 'category' | 'content'>> & { tags?: string[] }): void {
    const fields: string[] = [];
    const values: unknown[] = [];

    if (updates.title !== undefined) { fields.push('title = ?'); values.push(updates.title); }
    if (updates.category !== undefined) { fields.push('category = ?'); values.push(updates.category); }
    if (updates.content !== undefined) { fields.push('content = ?'); values.push(updates.content); }
    if (updates.tags !== undefined) { fields.push('tags = ?'); values.push(JSON.stringify(updates.tags)); }

    if (fields.length === 0) return;

    fields.push("updated_at = datetime('now')");
    values.push(id);

    const doUpdate = this.db.transaction(() => {
      // Save current version before overwriting
      const current = this.db.prepare('SELECT * FROM snapshots WHERE id = ?').get(id) as ContextSnapshot | undefined;
      if (current) {
        const maxVersion = this.db.prepare(
          'SELECT COALESCE(MAX(version), 0) as v FROM snapshot_versions WHERE snapshot_id = ?'
        ).get(id) as { v: number };

        this.db.prepare(`
          INSERT INTO snapshot_versions (snapshot_id, version, title, category, content, tags, updated_at, updated_by)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).run(id, maxVersion.v + 1, current.title, current.category, current.content, current.tags, current.updated_at, current.created_by);

        // Delete old FTS entry
        this.db.prepare(
          "INSERT INTO snapshots_fts(snapshots_fts, rowid, title, content, tags) VALUES ('delete', ?, ?, ?, ?)"
        ).run(current.id, current.title, current.content, current.tags);
      }

      this.db.prepare(`UPDATE snapshots SET ${fields.join(', ')} WHERE id = ?`).run(...values);

      // Insert new FTS entry
      const updated = this.db.prepare('SELECT * FROM snapshots WHERE id = ?').get(id) as ContextSnapshot | undefined;
      if (updated) {
        this.db.prepare(
          'INSERT INTO snapshots_fts(rowid, title, content, tags) VALUES (?, ?, ?, ?)'
        ).run(updated.id, updated.title, updated.content, updated.tags);
      }
    });

    doUpdate();
  }

  deleteSnapshot(id: number): void {
    this.db.prepare('DELETE FROM snapshots WHERE id = ?').run(id);
  }

  getSnapshotById(id: number): ContextSnapshot | undefined {
    return this.db
      .prepare('SELECT * FROM snapshots WHERE id = ?')
      .get(id) as ContextSnapshot | undefined;
  }

  listSnapshots(projectId: number, category?: SnapshotCategory): ContextSnapshot[] {
    if (category) {
      return this.db.prepare('SELECT * FROM snapshots WHERE project_id = ? AND category = ? ORDER BY created_at DESC')
        .all(projectId, category) as ContextSnapshot[];
    }
    return this.db.prepare('SELECT * FROM snapshots WHERE project_id = ? ORDER BY created_at DESC')
      .all(projectId) as ContextSnapshot[];
  }

  searchSnapshots(projectId: number, query: string): ContextSnapshot[] {
    const ftsQuery = query.replace(/[-*"(){}[\]^~\\:]/g, ' ').trim().split(/\s+/).filter(Boolean).join(' OR ');
    if (!ftsQuery) return [];
    try {
      return this.db.prepare(`
        SELECT s.* FROM snapshots_fts fts
        JOIN snapshots s ON s.id = fts.rowid
        WHERE fts.snapshots_fts MATCH ? AND s.project_id = ?
        ORDER BY rank
      `).all(ftsQuery, projectId) as ContextSnapshot[];
    } catch {
      // Fallback to LIKE if FTS fails
      const pattern = `%${query}%`;
      return this.db.prepare(
        'SELECT * FROM snapshots WHERE project_id = ? AND (title LIKE ? OR content LIKE ?) ORDER BY created_at DESC'
      ).all(projectId, pattern, pattern) as ContextSnapshot[];
    }
  }

  // ─── Costs ──────────────────────────────────────────────────────

  insertCost(data: {
    projectId: number;
    runId?: number;
    provider: string;
    model: string;
    operation: 'analysis' | 'embedding';
    filePath?: string;
    inputTokens: number;
    outputTokens: number;
    costUsd: number;
  }): void {
    this.db.prepare(`
      INSERT INTO costs (project_id, run_id, provider, model, operation, file_path, input_tokens, output_tokens, cost_usd)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      data.projectId, data.runId ?? null, data.provider, data.model, data.operation,
      data.filePath ?? null, data.inputTokens, data.outputTokens, data.costUsd
    );
  }

  getCostSummary(projectId: number, since?: string): CostSummary {
    const whereClause = since ? 'WHERE project_id = ? AND created_at >= ?' : 'WHERE project_id = ?';
    const params = since ? [projectId, since] : [projectId];

    const totals = this.db.prepare(`
      SELECT
        COALESCE(SUM(cost_usd), 0) as total_cost_usd,
        COALESCE(SUM(CASE WHEN operation = 'analysis' THEN cost_usd ELSE 0 END), 0) as llm_analysis_cost_usd,
        COALESCE(SUM(CASE WHEN operation = 'embedding' THEN cost_usd ELSE 0 END), 0) as embedding_cost_usd,
        COALESCE(SUM(CASE WHEN operation = 'analysis' THEN input_tokens ELSE 0 END), 0) as total_input_tokens,
        COALESCE(SUM(CASE WHEN operation = 'analysis' THEN output_tokens ELSE 0 END), 0) as total_output_tokens,
        COALESCE(SUM(CASE WHEN operation = 'embedding' THEN input_tokens ELSE 0 END), 0) as total_embedding_tokens,
        COUNT(DISTINCT run_id) as runs
      FROM costs ${whereClause}
    `).get(...params) as Record<string, number>;

    const byProvider = this.db.prepare(`
      SELECT provider,
        COALESCE(SUM(cost_usd), 0) as cost_usd,
        COALESCE(SUM(input_tokens), 0) as input_tokens,
        COALESCE(SUM(output_tokens), 0) as output_tokens
      FROM costs ${whereClause}
      GROUP BY provider
    `).all(...params) as Array<{ provider: string; cost_usd: number; input_tokens: number; output_tokens: number }>;

    return {
      total_cost_usd: totals.total_cost_usd,
      llm_analysis_cost_usd: totals.llm_analysis_cost_usd,
      embedding_cost_usd: totals.embedding_cost_usd,
      total_input_tokens: totals.total_input_tokens,
      total_output_tokens: totals.total_output_tokens,
      total_embedding_tokens: totals.total_embedding_tokens,
      runs: totals.runs,
      by_provider: Object.fromEntries(
        byProvider.map(p => [p.provider, { cost_usd: p.cost_usd, input_tokens: p.input_tokens, output_tokens: p.output_tokens }])
      ),
      by_project: {},
    };
  }

  getGlobalCostSummary(since?: string): CostSummary {
    const whereClause = since ? 'WHERE created_at >= ?' : '';
    const params = since ? [since] : [];

    const totals = this.db.prepare(`
      SELECT
        COALESCE(SUM(cost_usd), 0) as total_cost_usd,
        COALESCE(SUM(CASE WHEN operation = 'analysis' THEN cost_usd ELSE 0 END), 0) as llm_analysis_cost_usd,
        COALESCE(SUM(CASE WHEN operation = 'embedding' THEN cost_usd ELSE 0 END), 0) as embedding_cost_usd,
        COALESCE(SUM(CASE WHEN operation = 'analysis' THEN input_tokens ELSE 0 END), 0) as total_input_tokens,
        COALESCE(SUM(CASE WHEN operation = 'analysis' THEN output_tokens ELSE 0 END), 0) as total_output_tokens,
        COALESCE(SUM(CASE WHEN operation = 'embedding' THEN input_tokens ELSE 0 END), 0) as total_embedding_tokens,
        COUNT(DISTINCT run_id) as runs
      FROM costs ${whereClause}
    `).get(...params) as Record<string, number>;

    const byProvider = this.db.prepare(`
      SELECT provider,
        COALESCE(SUM(cost_usd), 0) as cost_usd,
        COALESCE(SUM(input_tokens), 0) as input_tokens,
        COALESCE(SUM(output_tokens), 0) as output_tokens
      FROM costs ${whereClause}
      GROUP BY provider
    `).all(...params) as Array<{ provider: string; cost_usd: number; input_tokens: number; output_tokens: number }>;

    const byProject = this.db.prepare(`
      SELECT p.name, COALESCE(SUM(c.cost_usd), 0) as cost_usd, COUNT(DISTINCT c.run_id) as runs
      FROM costs c JOIN projects p ON p.id = c.project_id
      ${whereClause ? whereClause.replace('created_at', 'c.created_at') : ''}
      GROUP BY p.name
    `).all(...params) as Array<{ name: string; cost_usd: number; runs: number }>;

    return {
      total_cost_usd: totals.total_cost_usd,
      llm_analysis_cost_usd: totals.llm_analysis_cost_usd,
      embedding_cost_usd: totals.embedding_cost_usd,
      total_input_tokens: totals.total_input_tokens,
      total_output_tokens: totals.total_output_tokens,
      total_embedding_tokens: totals.total_embedding_tokens,
      runs: totals.runs,
      by_provider: Object.fromEntries(
        byProvider.map(p => [p.provider, { cost_usd: p.cost_usd, input_tokens: p.input_tokens, output_tokens: p.output_tokens }])
      ),
      by_project: Object.fromEntries(
        byProject.map(p => [p.name, { cost_usd: p.cost_usd, runs: p.runs }])
      ),
    };
  }

  getRunCostSummary(runId: number): { cost_usd: number; input_tokens: number; output_tokens: number; embedding_tokens: number } {
    return this.db.prepare(`
      SELECT
        COALESCE(SUM(cost_usd), 0) as cost_usd,
        COALESCE(SUM(CASE WHEN operation = 'analysis' THEN input_tokens ELSE 0 END), 0) as input_tokens,
        COALESCE(SUM(CASE WHEN operation = 'analysis' THEN output_tokens ELSE 0 END), 0) as output_tokens,
        COALESCE(SUM(CASE WHEN operation = 'embedding' THEN input_tokens ELSE 0 END), 0) as embedding_tokens
      FROM costs WHERE run_id = ?
    `).get(runId) as { cost_usd: number; input_tokens: number; output_tokens: number; embedding_tokens: number };
  }

  // ─── Webhooks ───────────────────────────────────────────────────

  createWebhook(data: { projectId?: number; url: string; events: string[]; secret?: string }): Webhook {
    const result = this.db.prepare(`
      INSERT INTO webhooks (project_id, url, events, secret)
      VALUES (?, ?, ?, ?)
    `).run(data.projectId ?? null, data.url, JSON.stringify(data.events), data.secret ?? null);
    return this.db.prepare('SELECT * FROM webhooks WHERE id = ?').get(result.lastInsertRowid) as Webhook;
  }

  listWebhooks(projectId?: number): Webhook[] {
    if (projectId !== undefined) {
      return this.db.prepare('SELECT * FROM webhooks WHERE project_id = ? OR project_id IS NULL ORDER BY created_at')
        .all(projectId) as Webhook[];
    }
    return this.db.prepare('SELECT * FROM webhooks ORDER BY created_at').all() as Webhook[];
  }

  deleteWebhook(id: number): void {
    this.db.prepare('DELETE FROM webhooks WHERE id = ?').run(id);
  }

  getWebhooksForEvent(projectId: number, event: string): Webhook[] {
    return this.db.prepare(`
      SELECT w.* FROM webhooks w, json_each(w.events) je
      WHERE (w.project_id = ? OR w.project_id IS NULL)
        AND w.active = 1
        AND je.value = ?
    `).all(projectId, event) as Webhook[];
  }

  updateWebhookStatus(id: number, statusCode: number): void {
    this.db.prepare(`
      UPDATE webhooks SET last_triggered = datetime('now'), last_status = ? WHERE id = ?
    `).run(statusCode, id);
  }

  // ─── File Snapshots ─────────────────────────────────────────────

  saveFileSnapshot(data: {
    runId: number;
    projectId: number;
    filePath: string;
    contentHash: string;
    summary: string;
    concepts: string[];
    symbols: LLMSymbol[];
  }): void {
    this.db.prepare(`
      INSERT INTO file_snapshots (run_id, project_id, file_path, content_hash, summary, concepts, symbols)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      data.runId, data.projectId, data.filePath, data.contentHash,
      data.summary, JSON.stringify(data.concepts), JSON.stringify(data.symbols)
    );
  }

  getFileSnapshots(runId: number): FileSnapshot[] {
    return this.db.prepare('SELECT * FROM file_snapshots WHERE run_id = ? ORDER BY file_path')
      .all(runId) as FileSnapshot[];
  }

  // ─── Vector IDs ─────────────────────────────────────────────────

  saveVectorIds(projectId: number, vectors: Array<{ vectorId: string; filePath?: string; type: 'file' | 'symbol' | 'symbol_body' | 'snapshot' }>): void {
    const insert = this.db.prepare(`
      INSERT INTO vector_ids (project_id, vector_id, file_path, type)
      VALUES (?, ?, ?, ?)
    `);

    const batchInsert = this.db.transaction((items: typeof vectors) => {
      for (const v of items) {
        insert.run(projectId, v.vectorId, v.filePath ?? null, v.type);
      }
    });

    batchInsert(vectors);
  }

  getVectorIdsByProject(projectId: number): VectorIdRecord[] {
    return this.db.prepare('SELECT * FROM vector_ids WHERE project_id = ?')
      .all(projectId) as VectorIdRecord[];
  }

  deleteVectorIdsByProject(projectId: number): void {
    this.db.prepare('DELETE FROM vector_ids WHERE project_id = ?').run(projectId);
  }

  deleteVectorIdsByFile(projectId: number, filePath: string): string[] {
    const records = this.db.prepare('SELECT vector_id FROM vector_ids WHERE project_id = ? AND file_path = ?')
      .all(projectId, filePath) as Array<{ vector_id: string }>;
    this.db.prepare('DELETE FROM vector_ids WHERE project_id = ? AND file_path = ?').run(projectId, filePath);
    return records.map(r => r.vector_id);
  }

  // ─── Embedding diagnostics ──────────────────────────────────────

  /** Count vector_ids grouped by type for a project. */
  getVectorIdStats(projectId: number): { total: number; byType: Record<string, number> } {
    const rows = this.db
      .prepare('SELECT type, COUNT(*) AS cnt FROM vector_ids WHERE project_id = ? GROUP BY type')
      .all(projectId) as Array<{ type: string; cnt: number }>;
    const byType: Record<string, number> = {};
    let total = 0;
    for (const r of rows) {
      byType[r.type] = r.cnt;
      total += r.cnt;
    }
    return { total, byType };
  }

  /** Sample files that HAVE been embedded (embedding_hash IS NOT NULL). */
  sampleEmbeddedFiles(projectId: number, limit = 5): Array<{ id: number; path: string; embedding_hash: string }> {
    return this.db
      .prepare(
        `SELECT id, path, embedding_hash FROM files
         WHERE project_id = ? AND embedding_hash IS NOT NULL
         ORDER BY RANDOM() LIMIT ?`,
      )
      .all(projectId, limit) as Array<{ id: number; path: string; embedding_hash: string }>;
  }

  /** Sample files that have NOT been embedded yet. */
  sampleNotEmbeddedFiles(projectId: number, limit = 5): Array<{ id: number; path: string }> {
    return this.db
      .prepare(
        `SELECT id, path FROM files
         WHERE project_id = ? AND embedding_hash IS NULL
         ORDER BY RANDOM() LIMIT ?`,
      )
      .all(projectId, limit) as Array<{ id: number; path: string }>;
  }

  // ─── Embedding hashes (incremental reindex) ─────────────────────

  getFileEmbeddingHashes(fileIds: number[]): Map<number, string | null> {
    const out = new Map<number, string | null>();
    if (fileIds.length === 0) return out;
    const placeholders = fileIds.map(() => '?').join(',');
    const rows = this.db
      .prepare(`SELECT id, embedding_hash FROM files WHERE id IN (${placeholders})`)
      .all(...fileIds) as Array<{ id: number; embedding_hash: string | null }>;
    for (const r of rows) out.set(r.id, r.embedding_hash);
    return out;
  }

  setFileEmbeddingHash(fileId: number, hash: string): void {
    this.db.prepare('UPDATE files SET embedding_hash = ? WHERE id = ?').run(hash, fileId);
  }

  getFileStructureHash(projectId: number, path: string): string | null {
    const row = this.db.prepare(
      'SELECT structure_hash FROM files WHERE project_id = ? AND path = ?'
    ).get(projectId, path) as { structure_hash: string | null } | undefined;
    return row?.structure_hash ?? null;
  }

  setFileStructureHash(fileId: number, hash: string): void {
    this.db.prepare('UPDATE files SET structure_hash = ? WHERE id = ?').run(hash, fileId);
  }

  getFileStructureEmbedding(projectId: number, path: string): Float32Array | null {
    const row = this.db.prepare(
      'SELECT structure_embedding FROM files WHERE project_id = ? AND path = ?'
    ).get(projectId, path) as { structure_embedding: Buffer | null } | undefined;
    if (row?.structure_embedding) {
      return new Float32Array(row.structure_embedding.buffer, row.structure_embedding.byteOffset, row.structure_embedding.byteLength / 4);
    }
    return null;
  }

  setFileStructureEmbedding(fileId: number, embedding: Float32Array): void {
    const buffer = Buffer.from(embedding.buffer, embedding.byteOffset, embedding.byteLength);
    this.db.prepare('UPDATE files SET structure_embedding = ? WHERE id = ?').run(buffer, fileId);
  }


  getSymbolEmbeddingHashes(symbolIds: number[]): Map<number, { sig: string | null; body: string | null }> {
    const out = new Map<number, { sig: string | null; body: string | null }>();
    if (symbolIds.length === 0) return out;
    const placeholders = symbolIds.map(() => '?').join(',');
    const rows = this.db
      .prepare(
        `SELECT id, embedding_hash, body_embedding_hash FROM symbols WHERE id IN (${placeholders})`
      )
      .all(...symbolIds) as Array<{ id: number; embedding_hash: string | null; body_embedding_hash: string | null }>;
    for (const r of rows) out.set(r.id, { sig: r.embedding_hash, body: r.body_embedding_hash });
    return out;
  }

  setSymbolEmbeddingHash(symbolId: number, hash: string, kind: 'sig' | 'body'): void {
    const col = kind === 'sig' ? 'embedding_hash' : 'body_embedding_hash';
    this.db.prepare(`UPDATE symbols SET ${col} = ? WHERE id = ?`).run(hash, symbolId);
  }

  /**
   * Return embedding coverage for a project: how many files + symbols have
   * a stored embedding hash (= were successfully embedded at some point).
   * Used by get_project_pulse so the agent can decide whether vector search
   * is worth trying or should fall back to FTS.
   */
  getEmbeddingCoverage(projectId: number): {
    files_total: number;
    files_embedded: number;
    symbols_total: number;
    symbols_embedded: number;
    symbol_bodies_total: number;
    symbol_bodies_embedded: number;
  } {
    const files = this.db
      .prepare(
        'SELECT COUNT(*) AS total, COUNT(embedding_hash) AS embedded FROM files WHERE project_id = ?'
      )
      .get(projectId) as { total: number; embedded: number };
    const symbols = this.db
      .prepare(
        `SELECT COUNT(*) AS total, COUNT(embedding_hash) AS embedded, COUNT(body_embedding_hash) AS bodies,
                SUM(CASE WHEN kind IN ('class','function','interface','method') AND line IS NOT NULL THEN 1 ELSE 0 END) AS bodies_eligible
         FROM symbols WHERE project_id = ?`
      )
      .get(projectId) as { total: number; embedded: number; bodies: number; bodies_eligible: number };
    return {
      files_total: files.total,
      files_embedded: files.embedded,
      symbols_total: symbols.total,
      symbols_embedded: symbols.embedded,
      symbol_bodies_total: symbols.bodies_eligible,
      symbol_bodies_embedded: symbols.bodies,
    };
  }

  // ─── Models Cache ───────────────────────────────────────────────

  getCachedModels(provider: string): DiscoveredModel[] | null {
    const row = this.db.prepare('SELECT * FROM models_cache WHERE provider = ?')
      .get(provider) as { models: string; fetched_at: string } | undefined;
    if (!row) return null;

    // Check 24h freshness
    const fetchedAt = new Date(row.fetched_at + 'Z').getTime();
    const now = Date.now();
    if (now - fetchedAt > 24 * 60 * 60 * 1000) return null;

    return JSON.parse(row.models) as DiscoveredModel[];
  }

  setCachedModels(provider: string, models: DiscoveredModel[]): void {
    this.db.prepare(`
      INSERT INTO models_cache (provider, models, fetched_at)
      VALUES (?, ?, datetime('now'))
      ON CONFLICT(provider) DO UPDATE SET models = excluded.models, fetched_at = excluded.fetched_at
    `).run(provider, JSON.stringify(models));
  }

  // ─── Stats ──────────────────────────────────────────────────────

  getStats(projectId: number): ProjectStats {
    const project = this.getProject(projectId);
    const fileCounts = this.db.prepare(`
      SELECT COUNT(*) as file_count, COALESCE(SUM(line_count), 0) as total_lines, COALESCE(SUM(size), 0) as total_size
      FROM files WHERE project_id = ?
    `).get(projectId) as { file_count: number; total_lines: number; total_size: number };

    const symbolCount = this.db.prepare('SELECT COUNT(*) as cnt FROM symbols WHERE project_id = ?')
      .get(projectId) as { cnt: number };

    const languages = this.db.prepare(`
      SELECT language, COUNT(*) as cnt FROM files WHERE project_id = ? GROUP BY language ORDER BY cnt DESC
    `).all(projectId) as Array<{ language: string; cnt: number }>;

    const runCount = this.db.prepare('SELECT COUNT(*) as cnt FROM runs WHERE project_id = ?')
      .get(projectId) as { cnt: number };

    return {
      file_count: fileCounts.file_count,
      symbol_count: symbolCount.cnt,
      languages: Object.fromEntries(languages.map(l => [l.language, l.cnt])),
      total_lines: fileCounts.total_lines,
      total_size: fileCounts.total_size,
      last_indexed: project?.last_indexed ?? null,
      run_count: runCount.cnt,
    };
  }

  listConcepts(projectId: number): Array<{ concept: string; count: number }> {
    return this.db.prepare(`
      SELECT concept, COUNT(*) as count
      FROM file_concepts
      WHERE project_id = ?
      GROUP BY concept
      ORDER BY count DESC
    `).all(projectId) as Array<{ concept: string; count: number }>;
  }

  getFilesByConcept(projectId: number, concept: string): DBFile[] {
    return this.db.prepare(`
      SELECT f.* FROM files f
      JOIN file_concepts fc ON fc.file_id = f.id
      WHERE fc.project_id = ? AND fc.concept = ?
      ORDER BY f.path
    `).all(projectId, concept) as DBFile[];
  }

  getLastTwoRunIds(projectId: number): [number, number] | null {
    const runs = this.db.prepare(
      "SELECT id FROM runs WHERE project_id = ? AND status = 'completed' ORDER BY started_at DESC LIMIT 2"
    ).all(projectId) as Array<{ id: number }>;

    if (runs.length < 2) return null;
    return [runs[1].id, runs[0].id]; // [before, after]
  }

  // ─── File Dependencies ─────────────────────────────────────────

  upsertFileDependencies(projectId: number, sourceFileId: number, sourceFilePath: string, internalDeps: string[], externalDeps: string[]): void {
    const upsert = this.db.transaction(() => {
      this.db.prepare('DELETE FROM file_dependencies WHERE source_file_id = ?').run(sourceFileId);

      const insert = this.db.prepare(`
        INSERT INTO file_dependencies (project_id, source_file_id, target_file_id, import_path, dep_type)
        VALUES (?, ?, ?, ?, ?)
      `);

      for (const dep of internalDeps) {
        const target = this.resolveDepToFile(projectId, dep, sourceFilePath);
        insert.run(projectId, sourceFileId, target?.id ?? null, dep, 'internal');
      }

      for (const dep of externalDeps) {
        insert.run(projectId, sourceFileId, null, dep, 'external');
      }
    });

    upsert();
  }

  private getAliases(projectId: number): PathAlias[] {
    const cached = this.aliasCache.get(projectId);
    if (cached) return cached;
    const project = this.getProject(projectId);
    const aliases = project ? loadTsconfigPathAliases(project.root_path) : [];
    this.aliasCache.set(projectId, aliases);
    return aliases;
  }

  /** Invalidate alias cache (e.g. after a project is re-indexed and tsconfig may have changed). */
  clearAliasCache(projectId?: number): void {
    if (projectId === undefined) this.aliasCache.clear();
    else this.aliasCache.delete(projectId);
  }

  private resolveDepToFile(projectId: number, importPath: string, sourceFilePath: string): { id: number } | undefined {
    const normalizedImport = importPath.replace(/\\/g, '/');

    // Build candidate base paths. For relative imports this is a single
    // dir-resolved path; for alias imports there may be multiple targets.
    const basePaths: string[] = [];

    if (normalizedImport.startsWith('.')) {
      // Relative import: resolve against source file's directory.
      const sourceDir = sourceFilePath.replace(/\\/g, '/').split('/').slice(0, -1).join('/');
      const parts = normalizedImport.split('/');
      const dirParts = sourceDir ? sourceDir.split('/') : [];
      const resolved: string[] = [...dirParts];
      for (const part of parts) {
        if (part === '..') resolved.pop();
        else if (part !== '.' && part !== '') resolved.push(part);
      }
      basePaths.push(resolved.join('/'));
    } else {
      // Non-relative: try tsconfig path aliases first. If none match,
      // treat as a bare module and bail out (external dep).
      const aliases = this.getAliases(projectId);
      for (const alias of aliases) {
        if (alias.prefix === '' || normalizedImport.startsWith(alias.prefix)) {
          const tail = alias.prefix === '' ? normalizedImport : normalizedImport.slice(alias.prefix.length);
          for (const target of alias.targets) {
            // target may already end with '/' or not; normalize join.
            const joined = `${target.replace(/\/$/, '')}/${tail}`.replace(/\/+/g, '/');
            basePaths.push(joined);
          }
        }
      }
      if (basePaths.length === 0) return undefined;
    }

    // Strip .js/.mjs extension from import (TS projects import .js but files are .ts)
    const stmt = this.db.prepare('SELECT id FROM files WHERE project_id = ? AND path = ?');

    for (const raw of basePaths) {
      const basePath = raw.replace(/\.(js|mjs|cjs)$/, '');
      const candidates = [
        basePath + '.ts',
        basePath + '.tsx',
        basePath + '.mts',
        basePath + '.cts',
        basePath + '.js',
        basePath + '.jsx',
        basePath,
        basePath + '/index.ts',
        basePath + '/index.tsx',
        basePath + '/index.js',
        basePath + '/index.jsx',
      ];
      for (const candidate of candidates) {
        const file = stmt.get(projectId, candidate) as { id: number } | undefined;
        if (file) return file;
      }
    }
    return undefined;
  }

  getDependencies(fileId: number): DBFileDependency[] {
    return this.db.prepare(`
      SELECT fd.id, fd.import_path, fd.dep_type, f.path as target_file_path
      FROM file_dependencies fd
      LEFT JOIN files f ON f.id = fd.target_file_id
      WHERE fd.source_file_id = ?
      ORDER BY fd.dep_type, fd.import_path
    `).all(fileId) as DBFileDependency[];
  }

  getDependents(projectId: number, fileId: number): DBFileDependent[] {
    return this.db.prepare(`
      SELECT fd.id, fd.import_path, sf.path as source_file_path
      FROM file_dependencies fd
      JOIN files sf ON sf.id = fd.source_file_id
      WHERE fd.target_file_id = ? AND fd.project_id = ?
      ORDER BY sf.path
    `).all(fileId, projectId) as DBFileDependent[];
  }

  getCircularDeps(projectId: number): Array<{ path_a: string; path_b: string }> {
    return this.db.prepare(`
      SELECT DISTINCT f1.path as path_a, f2.path as path_b
      FROM file_dependencies d1
      JOIN file_dependencies d2 ON d1.target_file_id = d2.source_file_id
        AND d2.target_file_id = d1.source_file_id
      JOIN files f1 ON f1.id = d1.source_file_id
      JOIN files f2 ON f2.id = d1.target_file_id
      WHERE d1.project_id = ? AND f1.path < f2.path
    `).all(projectId) as Array<{ path_a: string; path_b: string }>;
  }

  // ─── Symbol References ─────────────────────────────────────────

  upsertSymbolReferences(
    projectId: number,
    fileId: number,
    filePath: string,
    references: Array<{ symbol_name: string; kind: string; line?: number; snippet?: string }>
  ): void {
    const upsert = this.db.transaction(() => {
      this.db.prepare('DELETE FROM symbol_references WHERE referencing_file_id = ?').run(fileId);

      const insert = this.db.prepare(`
        INSERT INTO symbol_references (project_id, symbol_id, symbol_name, referencing_file_id, referencing_file_path, line, context)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `);

      for (const ref of references) {
        const sym = this.db.prepare(
          'SELECT id FROM symbols WHERE project_id = ? AND name = ? LIMIT 1'
        ).get(projectId, ref.symbol_name) as { id: number } | undefined;

        insert.run(
          projectId,
          sym?.id ?? null,
          ref.symbol_name,
          fileId,
          filePath,
          ref.line ?? null,
          ref.snippet ?? null
        );
      }
    });

    upsert();
  }

  getSymbolReferences(symbolId: number): DBSymbolReference[] {
    return this.db.prepare('SELECT * FROM symbol_references WHERE symbol_id = ? ORDER BY referencing_file_path')
      .all(symbolId) as DBSymbolReference[];
  }

  getSymbolCallers(projectId: number, symbolName: string): DBSymbolReference[] {
    return this.db.prepare('SELECT * FROM symbol_references WHERE project_id = ? AND symbol_name = ? ORDER BY referencing_file_path')
      .all(projectId, symbolName) as DBSymbolReference[];
  }

  // ─── Symbol Relations ──────────────────────────────────────────

  getSymbolRelations(symbolId: number): DBSymbolRelation[] {
    return this.db.prepare('SELECT * FROM symbol_relations WHERE symbol_id = ?')
      .all(symbolId) as DBSymbolRelation[];
  }

  getImplementors(projectId: number, interfaceName: string): DBSymbol[] {
    return this.db.prepare(`
      SELECT s.* FROM symbol_relations sr
      JOIN symbols s ON s.id = sr.symbol_id
      WHERE sr.project_id = ? AND sr.related_symbol_name = ? AND sr.relation_type = 'implements'
      ORDER BY s.name
    `).all(projectId, interfaceName) as DBSymbol[];
  }

  getSubclasses(projectId: number, className: string): DBSymbol[] {
    return this.db.prepare(`
      SELECT s.* FROM symbol_relations sr
      JOIN symbols s ON s.id = sr.symbol_id
      WHERE sr.project_id = ? AND sr.related_symbol_name = ? AND sr.relation_type = 'extends'
      ORDER BY s.name
    `).all(projectId, className) as DBSymbol[];
  }

  getSymbolHierarchy(projectId: number, symbolName: string): {
    symbol: DBSymbol | undefined;
    extends_chain: string[];
    implements_list: string[];
    subclasses: DBSymbol[];
    implementors: DBSymbol[];
  } {
    const sym = this.db.prepare('SELECT * FROM symbols WHERE project_id = ? AND name = ? LIMIT 1')
      .get(projectId, symbolName) as DBSymbol | undefined;

    if (!sym) return { symbol: undefined, extends_chain: [], implements_list: [], subclasses: [], implementors: [] };

    const relations = this.getSymbolRelations(sym.id);
    const extends_chain = relations.filter(r => r.relation_type === 'extends').map(r => r.related_symbol_name);
    const implements_list = relations.filter(r => r.relation_type === 'implements').map(r => r.related_symbol_name);
    const subclasses = this.getSubclasses(projectId, symbolName);
    const implementors = this.getImplementors(projectId, symbolName);

    return { symbol: sym, extends_chain, implements_list, subclasses, implementors };
  }

  // ─── Architecture ──────────────────────────────────────────────

  getFilesByLayer(projectId: number, layer: string): DBFile[] {
    return this.db.prepare('SELECT * FROM files WHERE project_id = ? AND layer = ? ORDER BY path')
      .all(projectId, layer) as DBFile[];
  }

  getArchitectureOverview(projectId: number): Array<{ layer: string; count: number }> {
    return this.db.prepare(`
      SELECT layer, COUNT(*) as count
      FROM files WHERE project_id = ?
      GROUP BY layer ORDER BY count DESC
    `).all(projectId) as Array<{ layer: string; count: number }>;
  }

  // ─── Snapshot Versions ─────────────────────────────────────────

  getSnapshotHistory(snapshotId: number): SnapshotVersion[] {
    return this.db.prepare(
      'SELECT * FROM snapshot_versions WHERE snapshot_id = ? ORDER BY version DESC'
    ).all(snapshotId) as SnapshotVersion[];
  }

  // ─── Symbol Queries ────────────────────────────────────────────

  listSymbolsByKind(projectId: number, kind: string, limit: number = 50): DBSymbol[] {
    return this.db.prepare('SELECT * FROM symbols WHERE project_id = ? AND kind = ? ORDER BY name LIMIT ?')
      .all(projectId, kind, limit) as DBSymbol[];
  }

  /**
   * Trace the full usage tree of a symbol: who calls it, and who calls those callers.
   * Returns a tree structure up to maxDepth levels.
   */
  traceSymbolUsage(projectId: number, symbolName: string, maxDepth: number = 3): {
    symbol: string;
    defined_in: string | null;
    callers: Array<{
      file: string;
      line: number | null;
      symbols_in_file: string[];
      callers: unknown[];
    }>;
  } {
    const sym = this.db.prepare('SELECT * FROM symbols WHERE project_id = ? AND name = ? LIMIT 1')
      .get(projectId, symbolName) as DBSymbol | undefined;

    const definedIn = sym?.file_path ?? null;

    const visited = new Set<string>();

    const trace = (name: string, depth: number): Array<{
      file: string;
      line: number | null;
      symbols_in_file: string[];
      callers: unknown[];
    }> => {
      if (depth >= maxDepth || visited.has(name)) return [];
      visited.add(name);

      const refs = this.db.prepare(`
        SELECT referencing_file_path, line, context
        FROM symbol_references
        WHERE project_id = ? AND symbol_name = ?
        ORDER BY referencing_file_path
      `).all(projectId, name) as Array<{ referencing_file_path: string; line: number | null; context: string | null }>;

      const result: Array<{
        file: string;
        line: number | null;
        symbols_in_file: string[];
        callers: unknown[];
      }> = [];

      for (const ref of refs) {
        // Skip self-references (same file where symbol is defined)
        if (ref.referencing_file_path === definedIn) continue;

        // Find what symbols in that file could be "using" this one
        const fileSymbols = this.db.prepare(
          'SELECT name FROM symbols WHERE project_id = ? AND file_path = ? AND (kind = ? OR kind = ? OR kind = ?)'
        ).all(projectId, ref.referencing_file_path, 'function', 'method', 'class') as Array<{ name: string }>;

        const symNames = fileSymbols.map(s => s.name);

        // Recursively trace who calls the symbols in this file
        const nestedCallers: unknown[] = [];
        for (const s of symNames) {
          const nested = trace(s, depth + 1);
          if (nested.length > 0) nestedCallers.push(...nested);
        }

        result.push({
          file: ref.referencing_file_path,
          line: ref.line,
          symbols_in_file: symNames,
          callers: nestedCallers,
        });
      }

      return result;
    };

    return {
      symbol: symbolName,
      defined_in: definedIn,
      callers: trace(symbolName, 0),
    };
  }
}
