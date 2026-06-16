import type { Database as DB } from 'better-sqlite3';
import type {
  CoderSession,
  GlobalCoderSession,
  RecentCoderSession,
} from '@mcp/code-agent/sessions/types.js';
import { mapSessionRow, type SessionRow } from './mappers.js';
import * as sessionProjects from './session-projects.js';

export interface CreateSessionInput {
  project_id: number;
  title: string;
  provider: string;
  model: string;
  cloudcode_session_id?: string;
  agent?: string | null;
  /**
   * Optional phase profile binding (Camada 2). When set, the runner's
   * PhaseRouter resolves to this profile instead of walking the cascade
   * to project/global defaults. Null falls back to the cascade.
   */
  phase_profile_id?: number | null;
  /**
   * Global (multi-project) session flag (migration 152). Defaults to false.
   * Set via `createGlobal`, never directly by normal session creation.
   */
  is_global?: boolean;
}

/** Input for a global session: `project_id` is the PRIMARY; `secondaryProjects`
 *  are the additional linked roots (the primary is auto-linked). */
export interface CreateGlobalSessionInput extends CreateSessionInput {
  secondaryProjects: { projectId: number; label?: string | null }[];
}

export function create(db: DB, input: CreateSessionInput): CoderSession {
  // NOTE: the legacy `builder_json` column (migration 122) still exists in
  // SQLite but is no longer written — builder config is project-scoped
  // (`projects.builder_json`, migration 123).
  // `is_global` defaults to 0 in the schema; passing it explicitly keeps the
  // value byte-stable whether or not the column DEFAULT fired.
  const stmt = db.prepare(`
    INSERT INTO coder_sessions (project_id, title, provider, model, cloudcode_session_id, agent, phase_profile_id, is_global)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const r = stmt.run(
    input.project_id, input.title, input.provider, input.model,
    input.cloudcode_session_id ?? null,
    input.agent ?? null,
    input.phase_profile_id ?? null,
    input.is_global ? 1 : 0,
  );
  return get(db, Number(r.lastInsertRowid))!;
}

/**
 * Create a GLOBAL (multi-project) session atomically: the session row
 * (`is_global = 1`, `project_id` = primary) plus one `coder_session_projects`
 * link per project (primary marked `is_primary = 1`). The primary is always
 * linked even if it appears in `secondaryProjects` (deduped).
 */
export function createGlobal(db: DB, input: CreateGlobalSessionInput): CoderSession {
  const tx = db.transaction((): CoderSession => {
    const session = create(db, { ...input, is_global: true });
    sessionProjects.add(db, session.id, input.project_id, { isPrimary: true });
    for (const sp of input.secondaryProjects) {
      if (sp.projectId === input.project_id) continue; // primary already linked
      sessionProjects.add(db, session.id, sp.projectId, { label: sp.label ?? null });
    }
    return session;
  });
  return tx();
}

export function get(db: DB, id: number): CoderSession | null {
  const row = db.prepare('SELECT * FROM coder_sessions WHERE id = ?').get(id) as SessionRow | undefined;
  return mapSessionRow(row);
}

/**
 * List sessions for a project. By default returns only non-archived sessions.
 * Pass `{ archived: true }` to get the archived tab, or `{ archived: null }`
 * to get everything regardless of archive state.
 */
export function list(
  db: DB,
  projectId: number,
  opts: { archived?: boolean | null; groupId?: number | null } = {},
): CoderSession[] {
  // `is_global = 0`: global sessions live under their own "Sessões Globais"
  // menu and must never leak into a project's session list. The column DEFAULTs
  // to 0, so every pre-152 session still matches and nothing disappears.
  const clauses: string[] = ['project_id = ?', 'is_global = 0'];
  const params: (number | string)[] = [projectId];

  const archived = opts.archived === undefined ? false : opts.archived;
  if (archived !== null) {
    clauses.push('is_archived = ?');
    params.push(archived ? 1 : 0);
  }
  if (opts.groupId !== undefined) {
    if (opts.groupId === null) clauses.push('group_id IS NULL');
    else { clauses.push('group_id = ?'); params.push(opts.groupId); }
  }

  const sql = `SELECT * FROM coder_sessions WHERE ${clauses.join(' AND ')} ORDER BY is_favorite DESC, updated_at DESC`;
  const rows = db.prepare(sql).all(...params) as SessionRow[];
  return rows.map((r) => mapSessionRow(r)!);
}

/**
 * Cross-project recent sessions for the global sidebar. Joins projects to
 * enrich each row with the project name so the sidebar can render the
 * breadcrumb + navigate on click.
 */
export function listRecentGlobal(db: DB, limit = 10): RecentCoderSession[] {
  // Exclude `is_global` sessions: the topbar "recent" dropdown navigates to
  // `/projects/:id?session=`, which would open a global session in single-project
  // mode. Global sessions are reachable from their own menu instead.
  const rows = db
    .prepare(
      `SELECT s.*, p.name AS project_name
         FROM coder_sessions s
         JOIN projects p ON p.id = s.project_id
        WHERE s.is_archived = 0 AND s.is_global = 0
        ORDER BY s.is_favorite DESC, s.updated_at DESC
        LIMIT ?`,
    )
    .all(limit) as Array<SessionRow & { project_name: string }>;
  return rows.map((r) => {
    const mapped = mapSessionRow(r)!;
    return { ...mapped, project_name: r.project_name };
  });
}

/**
 * List GLOBAL sessions for the "Sessões Globais" sidebar. Enriches each row
 * with the primary project's name + the count of linked projects (so the UI can
 * render "N projetos" without an N+1). By default returns non-archived only.
 */
export function listGlobal(
  db: DB,
  opts: { archived?: boolean | null } = {},
): GlobalCoderSession[] {
  const clauses: string[] = ['s.is_global = 1'];
  const params: (number | string)[] = [];
  const archived = opts.archived === undefined ? false : opts.archived;
  if (archived !== null) {
    clauses.push('s.is_archived = ?');
    params.push(archived ? 1 : 0);
  }
  const rows = db
    .prepare(
      `SELECT s.*, p.name AS project_name,
              (SELECT COUNT(*) FROM coder_session_projects csp
                WHERE csp.coder_session_id = s.id) AS linked_count
         FROM coder_sessions s
         JOIN projects p ON p.id = s.project_id
        WHERE ${clauses.join(' AND ')}
        ORDER BY s.is_favorite DESC, s.updated_at DESC`,
    )
    .all(...params) as Array<SessionRow & { project_name: string; linked_count: number }>;
  return rows.map((r) => {
    const mapped = mapSessionRow(r)!;
    return { ...mapped, project_name: r.project_name, linked_count: r.linked_count };
  });
}

export function del(db: DB, id: number): void {
  db.prepare('DELETE FROM coder_sessions WHERE id = ?').run(id);
}

/** Atomic batch delete — all-or-nothing. Returns the number of rows removed. */
export function delBatch(db: DB, ids: number[]): number {
  if (ids.length === 0) return 0;
  const placeholders = ids.map(() => '?').join(',');
  const stmt = db.prepare(`DELETE FROM coder_sessions WHERE id IN (${placeholders})`);
  const tx = db.transaction((xs: number[]) => stmt.run(...xs));
  const r = tx(ids);
  return r.changes ?? 0;
}

/**
 * Boot-time sweep: flip any coder_sessions left in an active status back to
 * `idle`. The worker that owned them is gone — restart wiped its in-memory
 * state — so the run is unrecoverable. Without this, sessions sit with
 * `status='in_progress'` forever, the dashboard never re-engages.
 *
 * Idempotent. Returns the number of rows touched, for the boot log.
 */
export function recoverStale(db: DB): number {
  const result = db.prepare(`
    UPDATE coder_sessions
    SET status = 'idle', updated_at = datetime('now')
    WHERE status IN ('in_progress', 'running', 'working')
  `).run();
  return result.changes;
}

/**
 * Frente E — periodic watchdog sweep. Same shape as `recoverStale`, but
 * targets ONLY sessions whose `updated_at` is older than `maxAgeMs`. The
 * boot sweep catches worker-restart victims; this catches sessions that
 * the worker forgot about (heartbeat hang, infinite tool loop that the
 * runner-level guards missed) without resetting every active row on a
 * brand-new install.
 *
 * The threshold is intentionally generous (default 10 minutes) — a long
 * compaction or a legitimately slow provider response should never be
 * confused with a stuck session. Returns the number of rows touched so
 * the watchdog can decide whether to emit a warn-level log.
 */
export function recoverStuckRunning(
  db: DB,
  args: { maxAgeMs?: number } = {},
): number {
  const maxAgeMs = args.maxAgeMs ?? 10 * 60 * 1000; // 10min default
  const cutoffSeconds = Math.floor(maxAgeMs / 1000);
  const result = db.prepare(`
    UPDATE coder_sessions
    SET status = 'idle', updated_at = datetime('now')
    WHERE status IN ('in_progress', 'running', 'working')
      AND updated_at < datetime('now', '-' || ? || ' seconds')
  `).run(cutoffSeconds);
  return result.changes;
}
