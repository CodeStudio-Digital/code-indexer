import type { Database as DB } from 'better-sqlite3';

/** Return the set of tool names disabled for this session. */
export function getDisabled(db: DB, sessionId: number): Set<string> {
  const rows = db
    .prepare('SELECT tool_name FROM session_disabled_tools WHERE session_id = ?')
    .all(sessionId) as { tool_name: string }[];
  return new Set(rows.map((r) => r.tool_name));
}

/** Toggle a single tool for a session. */
export function setDisabled(db: DB, sessionId: number, toolName: string, disabled: boolean): void {
  if (disabled) {
    db.prepare(
      `INSERT OR IGNORE INTO session_disabled_tools (session_id, tool_name)
       VALUES (?, ?)`,
    ).run(sessionId, toolName);
  } else {
    db.prepare('DELETE FROM session_disabled_tools WHERE session_id = ? AND tool_name = ?').run(sessionId, toolName);
  }
}

/** Batch toggle tools for a session. */
export function bulkSetDisabled(db: DB, sessionId: number, toolNames: string[], disabled: boolean): void {
  const tx = db.transaction(() => {
    for (const name of toolNames) setDisabled(db, sessionId, name, disabled);
  });
  tx();
}

/** Copy disabled tool config from one session to another. */
export function copyConfig(db: DB, fromSessionId: number, toSessionId: number): number {
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM session_disabled_tools WHERE session_id = ?').run(toSessionId);
    const r = db.prepare(
      `INSERT INTO session_disabled_tools (session_id, tool_name)
       SELECT ?, tool_name FROM session_disabled_tools WHERE session_id = ?`,
    ).run(toSessionId, fromSessionId);
    return r.changes ?? 0;
  });
  return tx() as number;
}
