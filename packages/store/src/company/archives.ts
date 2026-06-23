import type { Database as DB } from 'better-sqlite3';
import type { CompanySessionArchive } from '@mcp/company/types.js';

interface ArchiveRow {
  id: number;
  company_session_id: number;
  archived_at: string;
  reason: string | null;
  included_kanban: number;
  included_sandbox: number;
  stats_json: string;
}

function mapArchiveRow(row: ArchiveRow): CompanySessionArchive {
  let stats = { agent_runs: 0, board_entries: 0, master_prompts: 0, kanban_cards: 0 };
  try {
    const parsed = JSON.parse(row.stats_json);
    stats = { ...stats, ...parsed };
  } catch { /* fall back to zeros */ }
  return {
    id: row.id,
    company_session_id: row.company_session_id,
    archived_at: row.archived_at,
    reason: row.reason,
    included_kanban: row.included_kanban === 1,
    included_sandbox: row.included_sandbox === 1,
    stats,
  };
}

export interface ArchiveOptions {
  reason?: string;
  includeKanban: boolean;
  includeSandbox: boolean;
}

/**
 * Archive all currently-active conversation state for a session and flip it
 * back to `idle`. After this call:
 *   - `listAgentRuns`, `readBoard`, `listMasterPrompts` return empty
 *     (the rows still exist but carry `archive_id` now).
 *   - If `opts.includeKanban`, kanban_cards are archived too.
 *   - Any agent_runs that were running, waiting*, or working are forced
 *     to `aborted` BEFORE stamping so the archive shows the real outcome.
 *   - Session status → `idle`, `master_session_id` cleared, so the next
 *     `/start` creates a fresh master.
 * Orchestrator eviction and sandbox teardown are done by the HTTP handler
 * (see archives.ts); this only touches the DB.
 */
export function archive(db: DB, companySessionId: number, opts: ArchiveOptions): CompanySessionArchive {
  const tx = db.transaction(() => {
    const insert = db.prepare(`
      INSERT INTO company_session_archives
        (company_session_id, reason, included_kanban, included_sandbox, stats_json)
      VALUES (?, ?, ?, ?, '{}')
    `);
    const r = insert.run(
      companySessionId,
      opts.reason ?? null,
      opts.includeKanban ? 1 : 0,
      opts.includeSandbox ? 1 : 0,
    );
    const archiveId = Number(r.lastInsertRowid);

    // Force still-live agent runs to 'aborted' first so the archived snapshot
    // reflects reality, not an impossible "running" state for rows whose runner
    // is already gone.
    db.prepare(`
      UPDATE company_agent_runs
         SET status = 'aborted',
             status_message = COALESCE(status_message, '') || ' [aborted by session reset]',
             updated_at = datetime('now')
       WHERE company_session_id = ?
         AND archive_id IS NULL
         AND status IN ('running','working','waiting','waiting_plan','waiting_question','waiting_tasks','reviewing','blocked','idle')
    `).run(companySessionId);

    const agentRunsCount = db.prepare(`
      UPDATE company_agent_runs SET archive_id = ?
      WHERE company_session_id = ? AND archive_id IS NULL
    `).run(archiveId, companySessionId).changes;

    const boardCount = db.prepare(`
      UPDATE company_board SET archive_id = ?
      WHERE company_session_id = ? AND archive_id IS NULL
    `).run(archiveId, companySessionId).changes;

    const masterPromptCount = db.prepare(`
      UPDATE company_master_prompts SET archive_id = ?
      WHERE company_session_id = ? AND archive_id IS NULL
    `).run(archiveId, companySessionId).changes;

    const kanbanCount = opts.includeKanban
      ? db.prepare(`
          UPDATE kanban_cards SET archive_id = ?
          WHERE company_session_id = ? AND archive_id IS NULL
        `).run(archiveId, companySessionId).changes
      : 0;

    // For CHILD sessions (fronts) we ALSO stamp `archived_at` so
    // `listChildSessions` stops returning it — otherwise an "archived" front
    // re-appears the next time the dashboard loads (migration 087).
    db.prepare(`
      UPDATE company_sessions
         SET status = 'idle',
             master_session_id = NULL,
             archived_at = CASE WHEN parent_session_id IS NULL THEN archived_at ELSE datetime('now') END,
             updated_at = datetime('now')
       WHERE id = ?
    `).run(companySessionId);

    const stats = {
      agent_runs: agentRunsCount,
      board_entries: boardCount,
      master_prompts: masterPromptCount,
      kanban_cards: kanbanCount,
    };
    db.prepare(`
      UPDATE company_session_archives SET stats_json = ? WHERE id = ?
    `).run(JSON.stringify(stats), archiveId);

    return getArchive(db, archiveId)!;
  });
  return tx();
}

export function getArchive(db: DB, id: number): CompanySessionArchive | null {
  const row = db.prepare('SELECT * FROM company_session_archives WHERE id = ?').get(id) as ArchiveRow | undefined;
  return row ? mapArchiveRow(row) : null;
}

export function listArchives(db: DB, companySessionId: number): CompanySessionArchive[] {
  const rows = db
    .prepare('SELECT * FROM company_session_archives WHERE company_session_id = ? ORDER BY archived_at DESC, id DESC')
    .all(companySessionId) as ArchiveRow[];
  return rows.map(mapArchiveRow);
}

/**
 * Pass/fail verdict for the most recent COMPLETED QA run scoped to a Kanban
 * feature card. The pipeline executor consults this for `pass-fail` branches
 * so it can rely on real test counts instead of parsing prose.
 */
export function getLatestQaVerdictForCard(db: DB, companySessionId: number, cardId: number): 'pass' | 'fail' | null {
  const row = db
    .prepare(
      `SELECT passed, failed FROM qa_test_runs
       WHERE company_session_id = ? AND kanban_feature_card_id = ? AND status = 'completed'
       ORDER BY datetime(started_at) DESC, id DESC
       LIMIT 1`,
    )
    .get(companySessionId, cardId) as { passed: number; failed: number } | undefined;
  if (!row) return null;
  if (row.failed > 0) return 'fail';
  if (row.passed > 0) return 'pass';
  return null;
}
