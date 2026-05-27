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

/** Chronological trace of every `todo_write` call in a session. */
export function listTodoHistory(db: DB, sessionId: number): { id: number; args_json: string; created_at: string }[] {
  return db.prepare(`
    SELECT tc.id, tc.args_json, tc.created_at
      FROM coder_tool_calls tc
      JOIN coder_messages m ON m.id = tc.message_id
     WHERE m.session_id = ?
       AND tc.tool_name = 'todo_write'
     ORDER BY tc.created_at ASC, tc.id ASC
  `).all(sessionId) as { id: number; args_json: string; created_at: string }[];
}
