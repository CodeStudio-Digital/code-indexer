import type { Database as DB } from 'better-sqlite3';
import type {
  CoderPlanRow,
  CoderPlanStatus,
} from '@mcp/code-agent/sessions/types.js';

export interface RecordPlanInput {
  session_id: number;
  tool_use_id: string;
  plan_text: string;
  message_id?: number | null;
}

/**
 * Persist a submit_plan call. INSERT … ON CONFLICT(tool_use_id) DO UPDATE so
 * a session resumed after restart that re-emits the same tool_use_id
 * refreshes the existing row instead of duplicating.
 */
export function record(db: DB, input: RecordPlanInput): CoderPlanRow {
  db.prepare(`
    INSERT INTO coder_plans (session_id, tool_use_id, plan_text, message_id, status)
    VALUES (?, ?, ?, ?, 'pending')
    ON CONFLICT(tool_use_id) DO UPDATE SET
      plan_text = excluded.plan_text,
      message_id = COALESCE(excluded.message_id, coder_plans.message_id)
  `).run(input.session_id, input.tool_use_id, input.plan_text, input.message_id ?? null);
  return db.prepare('SELECT * FROM coder_plans WHERE tool_use_id = ?').get(input.tool_use_id) as CoderPlanRow;
}

/**
 * Delete plans tied to a rolled-back region. `coder_plans.message_id` is
 * `ON DELETE SET NULL` (not CASCADE), so truncating messages would otherwise
 * leave orphan plan rows that `list()[0]` re-injects into the next run. Run
 * this BEFORE the message DELETE, while `message_id` is still intact: removes
 * the current turn's pending plan (`message_id IS NULL`) plus any plan in the
 * truncated tail (`message_id >= sinceMessageId`), preserving resolved plans
 * anchored to surviving messages.
 */
export function clearFrom(db: DB, sessionId: number, sinceMessageId: number): number {
  return db.prepare(
    'DELETE FROM coder_plans WHERE session_id = ? AND (message_id IS NULL OR message_id >= ?)',
  ).run(sessionId, sinceMessageId).changes;
}

export function resolve(db: DB, toolUseId: string, status: CoderPlanStatus, feedback?: string): void {
  db.prepare(`
    UPDATE coder_plans
       SET status = ?, feedback = ?, resolved_at = datetime('now')
     WHERE tool_use_id = ?
  `).run(status, feedback ?? null, toolUseId);
}

export function list(db: DB, sessionId: number): CoderPlanRow[] {
  return db.prepare('SELECT * FROM coder_plans WHERE session_id = ? ORDER BY created_at DESC, id DESC')
    .all(sessionId) as CoderPlanRow[];
}

export function get(db: DB, id: number): CoderPlanRow | null {
  const row = db.prepare('SELECT * FROM coder_plans WHERE id = ?').get(id) as CoderPlanRow | undefined;
  return row ?? null;
}
