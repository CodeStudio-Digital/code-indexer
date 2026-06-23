import { createHash } from 'node:crypto';
import type { Database as DB } from 'better-sqlite3';
import type {
  SessionInputKind,
  SessionInputRow,
} from '@mcp/code-agent/sessions/types.js';

export interface RecordSessionInput {
  session_id: number;
  kind: SessionInputKind;
  source_label: string;
  content: string;
  meta?: Record<string, unknown> | null;
}

/**
 * Record a hidden prompt injected into the session (system prompt, skill body
 * fetched mid-conversation, system-reminder, or sub-agent prompt).
 *
 * Dedup: if the latest row for the same `(session_id, kind)` has the same
 * content hash, we skip — turn-over-turn the system prompt is usually
 * byte-identical (cache prefix), so we only persist when something actually
 * changed (skill loaded, tier expanded, etc.).
 */
export function record(db: DB, input: RecordSessionInput): SessionInputRow | null {
  const hash = createHash('sha1').update(input.content).digest('hex');
  const last = db
    .prepare(
      `SELECT content_hash FROM coder_session_inputs
        WHERE session_id = ? AND kind = ?
        ORDER BY id DESC LIMIT 1`,
    )
    .get(input.session_id, input.kind) as { content_hash: string } | undefined;
  if (last && last.content_hash === hash) return null;

  const meta = input.meta ? JSON.stringify(input.meta) : null;
  const r = db
    .prepare(
      `INSERT INTO coder_session_inputs
         (session_id, kind, source_label, content, content_hash, meta_json)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(input.session_id, input.kind, input.source_label, input.content, hash, meta);
  return db
    .prepare('SELECT * FROM coder_session_inputs WHERE id = ?')
    .get(Number(r.lastInsertRowid)) as SessionInputRow;
}

/** Newest-first list for the Input tab in the session details modal. */
export function list(db: DB, sessionId: number): SessionInputRow[] {
  return db
    .prepare(
      `SELECT * FROM coder_session_inputs
        WHERE session_id = ?
        ORDER BY created_at DESC, id DESC`,
    )
    .all(sessionId) as SessionInputRow[];
}
