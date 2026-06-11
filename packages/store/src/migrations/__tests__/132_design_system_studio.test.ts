/**
 * Cobertura da migration 132 — recreate-table de `design_system_sessions`
 * para o DS Studio (company_session_id nullable, +project_id, +kind).
 *
 * Pin de invariantes (mesmo contrato da 103):
 *   - Rows legacy migram verbatim com kind='company' e project_id NULL.
 *   - CHECK de coerência: studio exige project_id; company exige
 *     company_session_id.
 *   - UNIQUE parcial: 1 sessão studio por projeto.
 *   - FKs filhas (design_system_versions.ds_session_id) sobrevivem ao
 *     recreate; cascade projects → sessions studio funciona.
 *   - Idempotente; foreign_keys=ON restaurado mesmo em crash.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import type DatabaseConstructor from 'better-sqlite3';
import { designSystemStudio132 } from '../132_design_system_studio.js';

type DB = InstanceType<typeof DatabaseConstructor>;
let db: DB;

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  // Emula o schema relevante: pais (company_sessions, projects,
  // mcp_server_configs), a tabela da 048+051 e uma filha com FK.
  db.exec(`
    CREATE TABLE company_sessions (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      name        TEXT NOT NULL
    );
    CREATE TABLE projects (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      name        TEXT NOT NULL
    );
    CREATE TABLE mcp_server_configs (
      id          TEXT PRIMARY KEY,
      name        TEXT NOT NULL
    );

    CREATE TABLE design_system_sessions (
      id                   INTEGER PRIMARY KEY AUTOINCREMENT,
      company_session_id   INTEGER NOT NULL
                           REFERENCES company_sessions(id) ON DELETE CASCADE,
      name                 TEXT NOT NULL,
      package_name         TEXT NOT NULL,
      stack                TEXT NOT NULL
                           CHECK(stack IN ('react-ts','vue-ts','angular')),
      source_zip_hash      TEXT,
      source_zip_path      TEXT,
      next_bump_hint       TEXT NOT NULL DEFAULT 'patch'
                           CHECK(next_bump_hint IN ('patch','minor','major')),
      mcp_server_config_id TEXT
                           REFERENCES mcp_server_configs(id) ON DELETE SET NULL,
      created_at           TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX idx_ds_sessions_company
      ON design_system_sessions(company_session_id);

    CREATE TABLE design_system_versions (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      ds_session_id  INTEGER NOT NULL
                     REFERENCES design_system_sessions(id) ON DELETE CASCADE,
      semver         TEXT NOT NULL
    );
  `);
});

afterEach(() => {
  db.close();
});

function seedLegacy(): void {
  db.prepare(`INSERT INTO company_sessions (name) VALUES ('cs1')`).run();
  db.prepare(
    `INSERT INTO design_system_sessions (company_session_id, name, package_name, stack, next_bump_hint)
     VALUES (1, 'Legacy DS', '@acme/legacy', 'react-ts', 'minor')`,
  ).run();
  db.prepare(
    `INSERT INTO design_system_versions (ds_session_id, semver) VALUES (1, '1.0.0')`,
  ).run();
}

describe('migration 132 — design_system_studio', () => {
  it('declares outsideTransaction: true', () => {
    expect(designSystemStudio132.outsideTransaction).toBe(true);
  });

  it('migrates legacy rows verbatim as kind=company with project_id NULL', () => {
    seedLegacy();
    designSystemStudio132.up(db);

    const row = db
      .prepare('SELECT * FROM design_system_sessions WHERE id = 1')
      .get() as Record<string, unknown>;
    expect(row.kind).toBe('company');
    expect(row.project_id).toBeNull();
    expect(row.company_session_id).toBe(1);
    expect(row.package_name).toBe('@acme/legacy');
    expect(row.next_bump_hint).toBe('minor');
  });

  it('accepts studio rows (project_id set, no company session)', () => {
    designSystemStudio132.up(db);
    db.prepare(`INSERT INTO projects (name) VALUES ('ds-ws')`).run();
    expect(() => {
      db.prepare(
        `INSERT INTO design_system_sessions (project_id, kind, name, package_name, stack)
         VALUES (1, 'studio', 'Acme DS', '@acme/ds', 'react-ts')`,
      ).run();
    }).not.toThrow();
  });

  it('CHECK rejects studio without project_id and company without company_session_id', () => {
    designSystemStudio132.up(db);
    expect(() => {
      db.prepare(
        `INSERT INTO design_system_sessions (kind, name, package_name, stack)
         VALUES ('studio', 'Bad', '@acme/bad', 'react-ts')`,
      ).run();
    }).toThrow(/CHECK constraint failed/);
    expect(() => {
      db.prepare(
        `INSERT INTO design_system_sessions (kind, name, package_name, stack)
         VALUES ('company', 'Bad', '@acme/bad', 'react-ts')`,
      ).run();
    }).toThrow(/CHECK constraint failed/);
  });

  it('enforces one studio session per project (partial UNIQUE)', () => {
    designSystemStudio132.up(db);
    db.prepare(`INSERT INTO projects (name) VALUES ('ds-ws')`).run();
    db.prepare(
      `INSERT INTO design_system_sessions (project_id, kind, name, package_name, stack)
       VALUES (1, 'studio', 'A', '@a/a', 'react-ts')`,
    ).run();
    expect(() => {
      db.prepare(
        `INSERT INTO design_system_sessions (project_id, kind, name, package_name, stack)
         VALUES (1, 'studio', 'B', '@b/b', 'react-ts')`,
      ).run();
    }).toThrow(/UNIQUE constraint failed/);
  });

  it('preserves child FK (versions) and cascades project delete to studio sessions', () => {
    seedLegacy();
    designSystemStudio132.up(db);

    // Filha legacy continua resolvendo.
    const joined = db
      .prepare(
        `SELECT v.semver FROM design_system_versions v
         JOIN design_system_sessions s ON s.id = v.ds_session_id`,
      )
      .all() as Array<{ semver: string }>;
    expect(joined).toEqual([{ semver: '1.0.0' }]);

    // Cascade novo: deletar o projeto some com a sessão studio + versões.
    db.prepare(`INSERT INTO projects (name) VALUES ('ds-ws')`).run();
    db.prepare(
      `INSERT INTO design_system_sessions (project_id, kind, name, package_name, stack)
       VALUES (1, 'studio', 'Acme DS', '@acme/ds', 'react-ts')`,
    ).run();
    const studioId = (db.prepare(`SELECT id FROM design_system_sessions WHERE kind='studio'`).get() as { id: number }).id;
    db.prepare(`INSERT INTO design_system_versions (ds_session_id, semver) VALUES (?, '0.1.0')`).run(studioId);

    db.prepare(`DELETE FROM projects WHERE id = 1`).run();
    const left = db
      .prepare(`SELECT COUNT(*) AS c FROM design_system_sessions WHERE kind='studio'`)
      .get() as { c: number };
    expect(left.c).toBe(0);
    const versionsLeft = db
      .prepare(`SELECT COUNT(*) AS c FROM design_system_versions WHERE ds_session_id = ?`)
      .get(studioId) as { c: number };
    expect(versionsLeft.c).toBe(0);
  });

  it('is idempotent — re-running is a no-op', () => {
    seedLegacy();
    designSystemStudio132.up(db);
    designSystemStudio132.up(db);
    const rows = db.prepare(`SELECT COUNT(*) AS c FROM design_system_sessions`).get() as { c: number };
    expect(rows.c).toBe(1);
  });

  it('restores PRAGMA foreign_keys=ON even when the migration crashes mid-run', () => {
    // Versão órfã (ds_session_id inexistente) → foreign_key_check dispara.
    db.pragma('foreign_keys = OFF');
    db.prepare(`INSERT INTO design_system_versions (ds_session_id, semver) VALUES (99, 'x')`).run();
    db.pragma('foreign_keys = ON');

    expect(() => designSystemStudio132.up(db)).toThrow(/foreign_key_check found/);
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
  });
});
