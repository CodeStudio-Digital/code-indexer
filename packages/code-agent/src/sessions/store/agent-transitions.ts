import type DatabaseConstructor from 'better-sqlite3';

type DB = InstanceType<typeof DatabaseConstructor>;

interface PendingAgentTransitionRow {
  session_id: number;
  from_agent: string | null;
  to_agent: string | null;
  updated_at: string;
}

export interface PendingAgentTransition {
  sessionId: number;
  fromAgent: string | null;
  toAgent: string | null;
  updatedAt: string;
}

function mapRow(row: PendingAgentTransitionRow | undefined): PendingAgentTransition | null {
  return row
    ? {
        sessionId: row.session_id,
        fromAgent: row.from_agent,
        toAgent: row.to_agent,
        updatedAt: row.updated_at,
      }
    : null;
}

function read(db: DB, sessionId: number): PendingAgentTransition | null {
  const row = db.prepare(`
    SELECT session_id, from_agent, to_agent, updated_at
      FROM coder_pending_agent_transitions
     WHERE session_id = ?
  `).get(sessionId) as PendingAgentTransitionRow | undefined;
  return mapRow(row);
}

/**
 * Persist a manual selector change without adding a model-facing message yet.
 * Repeated changes preserve the agent active before the first selection and
 * replace only the final target. Returning to the original agent cancels the
 * pending transition entirely.
 */
export function stage(
  db: DB,
  sessionId: number,
  nextAgent: string | null,
): PendingAgentTransition | null {
  return db.transaction(() => {
    const session = db.prepare('SELECT agent FROM coder_sessions WHERE id = ?')
      .get(sessionId) as { agent: string | null } | undefined;
    if (!session) return null;

    const pending = read(db, sessionId);
    if (session.agent === nextAgent) return pending;

    const fromAgent = pending?.fromAgent ?? session.agent;
    db.prepare(`
      UPDATE coder_sessions
         SET agent = ?,
             updated_at = datetime('now')
       WHERE id = ?
    `).run(nextAgent, sessionId);

    if (fromAgent === nextAgent) {
      db.prepare('DELETE FROM coder_pending_agent_transitions WHERE session_id = ?')
        .run(sessionId);
      return null;
    }

    db.prepare(`
      INSERT INTO coder_pending_agent_transitions
        (session_id, from_agent, to_agent, updated_at)
      VALUES (?, ?, ?, datetime('now'))
      ON CONFLICT(session_id) DO UPDATE SET
        from_agent = excluded.from_agent,
        to_agent = excluded.to_agent,
        updated_at = excluded.updated_at
    `).run(sessionId, fromAgent, nextAgent);

    return read(db, sessionId);
  })();
}

/** Atomically take the final transition immediately before the next run. */
export function consume(db: DB, sessionId: number): PendingAgentTransition | null {
  return db.transaction(() => {
    const pending = read(db, sessionId);
    if (!pending) return null;
    db.prepare('DELETE FROM coder_pending_agent_transitions WHERE session_id = ?')
      .run(sessionId);
    return pending;
  })();
}

export function get(db: DB, sessionId: number): PendingAgentTransition | null {
  return read(db, sessionId);
}
