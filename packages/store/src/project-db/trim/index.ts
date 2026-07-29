/**
 * C2 — trim a per-project DB to project-only tables.
 *
 * The project DB is built from the full central schema, so it inherits ~93
 * central-only tables. This drops them + recreates the project tables that carry
 * a cross-DB FK without it, leaving a project-only sqlite_master. Idempotent
 * (keyed off a `project_db_meta` marker, NOT schema_version) + crash-safe
 * (foreign_keys OFF outside any tx; every step IF-EXISTS / re-strippable).
 *
 * Invoked ONLY from initProjectSchema (a per-project .mcp-indexer/index.db). It
 * is NEVER called against the central DB (which opens via the CodeIndexDB
 * constructor, not initProjectSchema), so the central DB is structurally
 * unreachable from here — see project-schema.ts.
 */
import type { DB } from '../../db/types.js';
import { projectDbFlags } from '@mcp/shared/utils/config.js';
import { CENTRAL_FTS_VTABS, assertDisjointFromProject, centralTablesIn } from './drop-list.js';
import { recreateFkEdgeTables } from './fk-recreate.js';

const MARKER_KEY = 'trim_version';
// v2 added central tables introduced by migrations 181-217 and removed the retired
// semantic vector ledgers. v3 adds the MCP connection profiles (240), the control
// plane + policy engine (251-257) and the per-session runtime tables (249/253/
// 258/259), and switches the drop to `centralTablesIn` so a future central table
// is swept even without a version bump. Project DBs stamped with an older marker
// run the expanded trim once on reopen.
const TRIM_VERSION = '3';

function ensureMetaTable(db: DB): void {
  db.exec(`CREATE TABLE IF NOT EXISTS project_db_meta (key TEXT PRIMARY KEY, value TEXT)`);
}

function alreadyTrimmed(db: DB, central: readonly string[]): boolean {
  const row = db.prepare(`SELECT value AS v FROM project_db_meta WHERE key = ?`).get(MARKER_KEY) as
    | { v?: string }
    | undefined;
  if (row?.v !== TRIM_VERSION) return false;

  // initProjectSchema runs the shared central bootstrap before this function.
  // On reopen that bootstrap can recreate central base tables even though the
  // project DB was trimmed previously, so the marker alone is not sufficient.
  // `central` also carries the derived sweep, so a central table introduced by a
  // migration NEWER than this marker re-arms the trim without a version bump.
  const present = new Set((db.prepare(
    `SELECT name FROM sqlite_master WHERE type = 'table'`,
  ).all() as Array<{ name: string }>).map((entry) => entry.name));
  return !central.some((table) => present.has(table))
    && !CENTRAL_FTS_VTABS.some((table) => present.has(table));
}

/** Drop the central FTS vtabs first (removes their shadow tables) so the base
 *  drops below don't leave orphaned vtabs pointing at gone content tables. The
 *  base tables' own sync triggers drop automatically with the base table. */
function dropCentralFts(db: DB): void {
  for (const vtab of CENTRAL_FTS_VTABS) {
    try { db.exec(`DROP TABLE IF EXISTS "${vtab}"`); } catch { /* corrupt vtab — tolerated */ }
  }
}

function dropCentralTables(db: DB, central: readonly string[]): void {
  for (const t of central) {
    db.exec(`DROP TABLE IF EXISTS "${t}"`);
  }
}

/**
 * Trim `db` (a freshly schema-initialized per-project DB) to project-only tables.
 * No-op when the trim flag is off or the marker is already stamped. Throws if a
 * dangling cross-DB FK survives (foreign_key_check), so a miswire fails loudly
 * rather than silently corrupting writes.
 */
export function trimProjectSchema(db: DB): void {
  if (!projectDbFlags().trim) return;
  ensureMetaTable(db);
  const central = centralTablesIn(db);
  if (alreadyTrimmed(db, central)) return;
  assertDisjointFromProject(); // guards a project/central classification slip

  const fkWasOn = db.pragma('foreign_keys', { simple: true }) === 1;
  if (fkWasOn) db.pragma('foreign_keys = OFF'); // MUST be outside any tx (no-op inside)
  try {
    recreateFkEdgeTables(db, central); // strip cross-DB FKs from project tables first
    dropCentralFts(db);                // central FTS vtabs (+ their shadow tables)
    dropCentralTables(db, central);    // the ~110 central base tables
    const violations = db.pragma('foreign_key_check') as unknown[];
    if (violations.length > 0) {
      throw new Error(`[project-db/trim] ${violations.length} dangling FK(s) after trim — aborting`);
    }
  } finally {
    if (fkWasOn) db.pragma('foreign_keys = ON');
  }

  db.prepare(`INSERT OR REPLACE INTO project_db_meta (key, value) VALUES (?, ?)`).run(MARKER_KEY, TRIM_VERSION);
}
