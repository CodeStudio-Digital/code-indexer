import type { Database as DB } from 'better-sqlite3';
import type {
  AgentInboxMessage,
  InboxKind,
  InboxPriority,
  InboxStatus,
} from '@mcp/company/types.js';

/**
 * Claim ordering: urgent before normal before low (NULL → normal for pre-184
 * rows), then oldest-first within a priority. A urgent blocker jumps ahead of a
 * queue of FYIs instead of waiting behind them.
 */
const PRIORITY_ORDER_SQL =
  "CASE COALESCE(priority, 'normal') WHEN 'urgent' THEN 0 WHEN 'normal' THEN 1 ELSE 2 END ASC";

interface InboxRow {
  id: number;
  company_session_id: number;
  from_agent_run_id: number;
  from_role: string;
  to_role: string | null;
  to_agent_run_id: number | null;
  kind: string;
  body: string;
  status: string;
  answer: string | null;
  wait_token: string | null;
  created_at: string;
  delivered_at: string | null;
  answered_at: string | null;
  // Threading + priority (migration 184). Nullable on rows created before it.
  thread_id: number | null;
  reply_to_message_id: number | null;
  priority: string | null;
  context_json: string | null;
}

function mapInboxRow(row: InboxRow): AgentInboxMessage {
  return {
    id: row.id,
    company_session_id: row.company_session_id,
    from_agent_run_id: row.from_agent_run_id,
    from_role: row.from_role,
    to_role: row.to_role,
    to_agent_run_id: row.to_agent_run_id,
    kind: row.kind as InboxKind,
    body: row.body,
    status: row.status as InboxStatus,
    answer: row.answer,
    wait_token: row.wait_token,
    created_at: row.created_at,
    delivered_at: row.delivered_at,
    answered_at: row.answered_at,
    thread_id: row.thread_id,
    reply_to_message_id: row.reply_to_message_id,
    priority: (row.priority ?? 'normal') as InboxPriority,
    context_json: row.context_json,
  };
}

export interface CreateInboxMessageInput {
  companySessionId: number;
  fromAgentRunId: number;
  fromRole: string;
  toRole?: string | null;
  toAgentRunId?: number | null;
  kind: InboxKind;
  body: string;
  waitToken?: string | null;
  /** Conversation this message belongs to. Omit → the new row roots its own thread. */
  threadId?: number | null;
  /** The message this one replies to / continues. */
  replyToMessageId?: number | null;
  /** Delivery priority. Default 'normal'. */
  priority?: InboxPriority;
  /** Small structured context payload (card_id/decision_id/file refs) as JSON. */
  contextJson?: string | null;
}

export interface ListInboxOptions {
  companySessionId: number;
  status?: InboxStatus | InboxStatus[];
  toRole?: string;
  toAgentRunId?: number;
  fromAgentRunId?: number;
  limit?: number;
}

export function create(db: DB, input: CreateInboxMessageInput): AgentInboxMessage {
  const tx = db.transaction((): number => {
    const r = db.prepare(`
      INSERT INTO agent_inbox
        (company_session_id, from_agent_run_id, from_role, to_role, to_agent_run_id,
         kind, body, wait_token, thread_id, reply_to_message_id, priority, context_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.companySessionId,
      input.fromAgentRunId,
      input.fromRole,
      input.toRole ?? null,
      input.toAgentRunId ?? null,
      input.kind,
      input.body,
      input.waitToken ?? null,
      input.threadId ?? null,
      input.replyToMessageId ?? null,
      input.priority ?? 'normal',
      input.contextJson ?? null,
    );
    const id = Number(r.lastInsertRowid);
    // Root a fresh conversation on itself so every message carries a stable
    // thread_id (readers never have to coalesce id).
    if (input.threadId == null) {
      db.prepare('UPDATE agent_inbox SET thread_id = ? WHERE id = ?').run(id, id);
    }
    return id;
  });
  return get(db, tx())!;
}

export function get(db: DB, id: number): AgentInboxMessage | null {
  const row = db.prepare('SELECT * FROM agent_inbox WHERE id = ?').get(id) as InboxRow | undefined;
  return row ? mapInboxRow(row) : null;
}

/**
 * Direct lookup of the message bearing a blocking `wait_token`. `wait_token`
 * is unique per session, so this returns the single matching row (or null).
 *
 * Replaces InboxQueue's old `list({ limit: 200 }).find(...)` scan, which
 * silently failed to find an answer whose row had aged past the 200
 * most-recent messages under load. A direct WHERE is both correct (no row
 * cap) and cheap; an index on `wait_token` lands with the Phase 4 migration.
 */
export function getByWaitToken(
  db: DB,
  companySessionId: number,
  token: string,
): AgentInboxMessage | null {
  const row = db
    .prepare('SELECT * FROM agent_inbox WHERE company_session_id = ? AND wait_token = ? LIMIT 1')
    .get(companySessionId, token) as InboxRow | undefined;
  return row ? mapInboxRow(row) : null;
}

/**
 * List messages scoped to a session. Filters narrow the result so the
 * dashboard inbox panel and the cycle detector can both reuse the same path.
 * Ordered oldest-first so callers picking "the next one" get FIFO semantics.
 */
export function list(db: DB, opts: ListInboxOptions): AgentInboxMessage[] {
  const where: string[] = ['company_session_id = ?'];
  const params: unknown[] = [opts.companySessionId];
  if (opts.status) {
    const arr = Array.isArray(opts.status) ? opts.status : [opts.status];
    where.push(`status IN (${arr.map(() => '?').join(',')})`);
    for (const s of arr) params.push(s);
  }
  if (opts.toRole) { where.push('to_role = ?'); params.push(opts.toRole); }
  if (typeof opts.toAgentRunId === 'number') { where.push('to_agent_run_id = ?'); params.push(opts.toAgentRunId); }
  if (typeof opts.fromAgentRunId === 'number') { where.push('from_agent_run_id = ?'); params.push(opts.fromAgentRunId); }
  let sql = `SELECT * FROM agent_inbox WHERE ${where.join(' AND ')} ORDER BY datetime(created_at) ASC, id ASC`;
  if (typeof opts.limit === 'number') sql += ` LIMIT ${Math.max(1, Math.floor(opts.limit))}`;
  const rows = db.prepare(sql).all(...params) as InboxRow[];
  return rows.map(mapInboxRow);
}

/**
 * Atomically claim the next pending message for `(toAgentRunId OR toRole)`
 * and flip it to `delivered`. The conditional UPDATE protects against two
 * competing drains racing on the same row.
 */
export function claimNextForAgent(
  db: DB,
  args: { companySessionId: number; agentRunId: number; role: string },
): AgentInboxMessage | null {
  const tx = db.transaction(() => {
    const row = db.prepare(
      `SELECT * FROM agent_inbox
       WHERE company_session_id = ?
         AND status = 'pending'
         AND (to_agent_run_id = ? OR (to_agent_run_id IS NULL AND to_role = ?))
       ORDER BY ${PRIORITY_ORDER_SQL}, datetime(created_at) ASC, id ASC
       LIMIT 1`,
    ).get(args.companySessionId, args.agentRunId, args.role) as InboxRow | undefined;
    if (!row) return null;
    const result = db.prepare(
      `UPDATE agent_inbox
       SET status = 'delivered', delivered_at = datetime('now'), to_agent_run_id = ?
       WHERE id = ? AND status = 'pending'`,
    ).run(args.agentRunId, row.id);
    if (result.changes === 0) return null;
    return get(db, row.id);
  });
  return tx();
}

export function answer(db: DB, id: number, answerText: string): AgentInboxMessage | null {
  const r = db.prepare(
    `UPDATE agent_inbox SET status = 'answered', answer = ?, answered_at = datetime('now')
     WHERE id = ? AND status IN ('pending','delivered')`,
  ).run(answerText, id);
  if (r.changes === 0) return null;
  return get(db, id);
}

/**
 * Atomically claim every `pending` message addressed to the master sentinel
 * (`to_role = '__master__'`) for a session and flip them to `delivered`.
 *
 * The router coalesces multiple subordinate notifications into a single
 * master turn — the claim is batched rather than one-at-a-time. The
 * conditional `WHERE status = 'pending'` prevents two competing routers
 * from double-delivering the same row.
 */
export function claimAllPendingMasterMessages(db: DB, companySessionId: number): AgentInboxMessage[] {
  const tx = db.transaction(() => {
    const rows = db.prepare(
      `SELECT * FROM agent_inbox
       WHERE company_session_id = ?
         AND to_role = '__master__'
         AND status = 'pending'
       ORDER BY ${PRIORITY_ORDER_SQL}, datetime(created_at) ASC, id ASC`,
    ).all(companySessionId) as InboxRow[];
    if (rows.length === 0) return [] as AgentInboxMessage[];
    const update = db.prepare(
      `UPDATE agent_inbox
       SET status = 'delivered', delivered_at = datetime('now')
       WHERE id = ? AND status = 'pending'`,
    );
    const claimed: AgentInboxMessage[] = [];
    for (const row of rows) {
      const result = update.run(row.id);
      if (result.changes > 0) {
        const m = get(db, row.id);
        if (m) claimed.push(m);
      }
    }
    return claimed;
  });
  return tx();
}

/**
 * Session ids that currently have at least one `pending` message addressed
 * to the master sentinel. Used by the orchestrator's boot-time revival scan
 * so a crashed server doesn't strand the master while subordinate
 * notifications sit in the queue.
 */
export function listSessionsWithPendingMaster(db: DB): number[] {
  const rows = db.prepare(
    `SELECT DISTINCT company_session_id AS id
     FROM agent_inbox
     WHERE to_role = '__master__' AND status = 'pending'`,
  ).all() as { id: number }[];
  return rows.map((r) => r.id);
}

export function setStatus(
  db: DB,
  id: number,
  status: InboxStatus,
  opts?: { answer?: string },
): AgentInboxMessage | null {
  const sets: string[] = ['status = ?'];
  const params: unknown[] = [status];
  if (status === 'answered' || status === 'expired' || status === 'cancelled') {
    sets.push("answered_at = COALESCE(answered_at, datetime('now'))");
  }
  if (opts?.answer != null) { sets.push('answer = ?'); params.push(opts.answer); }
  params.push(id);
  const r = db.prepare(`UPDATE agent_inbox SET ${sets.join(', ')} WHERE id = ?`).run(...params);
  if (r.changes === 0) return null;
  return get(db, id);
}
