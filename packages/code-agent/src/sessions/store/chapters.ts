import type { Database as DB } from 'better-sqlite3';
import { buildFtsMatch } from '@mcp/store/db/fts-query.js';
import type {
  CoderMessageRow,
  CommitConversationChapterInput,
  CommitConversationChapterResult,
  ConversationChapterPage,
  ConversationChapterRow,
  ConversationChapterSearchResult,
} from '@mcp/code-agent/sessions/types.js';

export { copy, insertRebuilt, rollback, supersede } from './chapters-lifecycle.js';

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

function pageLimit(value: number | undefined): number {
  if (!Number.isFinite(value)) return DEFAULT_LIMIT;
  return Math.max(1, Math.min(MAX_LIMIT, Math.trunc(value!)));
}

function cursor(prefix: string, value: number): string {
  return `${prefix}:${value}`;
}

function parseCursor(value: string | null | undefined, prefix: string): number | null {
  if (!value) return null;
  const match = new RegExp(`^${prefix}:(\\d+)$`).exec(value);
  if (!match) return null;
  const parsed = Number(match[1]);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

function currentBoundary(db: DB, sessionId: number): number {
  const row = db.prepare(`
    SELECT COALESCE(summary_boundary_id, 0) AS boundary
    FROM coder_sessions WHERE id = ?
  `).get(sessionId) as { boundary: number } | undefined;
  if (!row) throw new Error(`session ${sessionId} not found`);
  return row.boundary;
}

function getByEnd(db: DB, sessionId: number, endMessageId: number): ConversationChapterRow | null {
  return (db.prepare(`
    SELECT * FROM coder_session_chapters
    WHERE session_id = ? AND end_message_id = ? AND superseded_at IS NULL
  `).get(sessionId, endMessageId) as ConversationChapterRow | undefined) ?? null;
}

/** Append one chapter and compare-and-set its durable boundary atomically. */
export function commit(
  db: DB,
  input: CommitConversationChapterInput,
): CommitConversationChapterResult {
  const expected = input.expectedBoundaryId;
  const start = input.startMessageId;
  const end = input.endMessageId;
  if (!Number.isSafeInteger(expected) || expected < 0 ||
      !Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start <= 0 || end < start) {
    throw new RangeError(`invalid chapter span ${input.startMessageId}..${input.endMessageId}`);
  }
  if (input.version <= 0 || !Number.isSafeInteger(input.version)) {
    throw new RangeError(`invalid chapter version ${input.version}`);
  }
  if (!input.title.trim() || !input.chapterText.trim() || !input.resumeText.trim()) {
    throw new Error('chapter title, chapterText, and resumeText must not be empty');
  }

  const tx = db.transaction((): CommitConversationChapterResult => {
    const boundary = currentBoundary(db, input.sessionId);
    const duplicate = getByEnd(db, input.sessionId, end);
    if (duplicate) {
      return {
        status: 'noop', reason: 'already_committed', chapter: duplicate,
        boundary_id: boundary, pruned_count: 0,
      };
    }
    if (boundary !== expected || end <= boundary) {
      return {
        status: 'noop', reason: 'boundary_changed',
        boundary_id: boundary, pruned_count: 0,
      };
    }

    // The chapter must cover the complete newly-archived interval, not a
    // hand-picked subset. Message ids are global, hence MIN(id), not boundary+1.
    const span = db.prepare(`
      SELECT COUNT(*) AS count, MIN(id) AS first_id, MAX(id) AS last_id
      FROM coder_messages
      WHERE session_id = ? AND id > ? AND id <= ?
    `).get(input.sessionId, boundary, end) as {
      count: number;
      first_id: number | null;
      last_id: number | null;
    };
    if (span.count === 0) {
      return {
        status: 'noop', reason: 'no_messages',
        boundary_id: boundary, pruned_count: 0,
      };
    }
    if (span.first_id !== start || span.last_id !== end) {
      throw new RangeError(
        `chapter span must cover all new messages: expected ${span.first_id}..${span.last_id}, got ${start}..${end}`,
      );
    }

    const ordinal = (db.prepare(`
      SELECT COALESCE(MAX(ordinal), 0) + 1 AS ordinal
      FROM coder_session_chapters WHERE session_id = ?
    `).get(input.sessionId) as { ordinal: number }).ordinal;

    const inserted = db.prepare(`
      INSERT INTO coder_session_chapters (
        session_id, ordinal, start_message_id, end_message_id,
        source, trigger, title,
        chapter_json, chapter_text, resume_json, resume_text,
        version, metrics_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.sessionId, ordinal, start, end,
      input.source, input.trigger, input.title,
      input.chapterJson, input.chapterText, input.resumeJson, input.resumeText,
      input.version, input.metricsJson ?? null,
    );

    const updated = db.prepare(`
      UPDATE coder_sessions
      SET summary_boundary_id = ?,
          compaction_summary = ?,
          last_response_id = NULL,
          last_response_message_count = NULL,
          compaction_count_auto = COALESCE(compaction_count_auto, 0) + ?,
          compaction_count_manual = COALESCE(compaction_count_manual, 0) + ?,
          updated_at = datetime('now')
      WHERE id = ? AND COALESCE(summary_boundary_id, 0) = ?
    `).run(
      end, input.resumeText,
      input.source === 'auto' ? 1 : 0,
      input.source === 'manual' ? 1 : 0,
      input.sessionId, expected,
    );
    if (updated.changes !== 1) throw new Error('chapter boundary changed during commit');

    const chapter = db.prepare('SELECT * FROM coder_session_chapters WHERE id = ?')
      .get(Number(inserted.lastInsertRowid)) as ConversationChapterRow;
    return {
      status: 'committed', chapter,
      boundary_id: end, pruned_count: span.count,
    };
  });
  return tx();
}

export function list(
  db: DB,
  sessionId: number,
  opts: { limit?: number; cursor?: string | null; includeSuperseded?: boolean } = {},
): ConversationChapterPage<ConversationChapterRow> {
  const limit = pageLimit(opts.limit);
  const beforeOrdinal = parseCursor(opts.cursor, 'chapter');
  const rows = db.prepare(`
    SELECT * FROM coder_session_chapters
    WHERE session_id = ?
      AND (? = 1 OR superseded_at IS NULL)
      AND (? IS NULL OR ordinal < ?)
    ORDER BY ordinal DESC
    LIMIT ?
  `).all(
    sessionId, opts.includeSuperseded ? 1 : 0,
    beforeOrdinal, beforeOrdinal,
    limit + 1,
  ) as ConversationChapterRow[];
  const items = rows.slice(0, limit);
  return {
    items,
    next_cursor: rows.length > limit && items.length > 0
      ? cursor('chapter', items[items.length - 1].ordinal)
      : null,
  };
}

export function count(db: DB, sessionId: number, includeSuperseded = false): number {
  return (db.prepare(`
    SELECT COUNT(*) AS count FROM coder_session_chapters
    WHERE session_id = ? AND (? = 1 OR superseded_at IS NULL)
  `).get(sessionId, includeSuperseded ? 1 : 0) as { count: number }).count;
}

function searchRows(
  db: DB,
  sessionId: number,
  match: string,
  limit: number,
  offset: number,
): ConversationChapterSearchResult[] {
  return db.prepare(`
    SELECT c.*, bm25(coder_session_chapters_fts) AS rank
    FROM coder_session_chapters_fts
    JOIN coder_session_chapters c ON c.id = coder_session_chapters_fts.rowid
    WHERE coder_session_chapters_fts MATCH ?
      AND c.session_id = ?
      AND c.superseded_at IS NULL
    ORDER BY rank ASC, c.ordinal DESC
    LIMIT ? OFFSET ?
  `).all(match, sessionId, limit, offset) as ConversationChapterSearchResult[];
}

export function search(
  db: DB,
  sessionId: number,
  query: string,
  opts: { limit?: number; cursor?: string | null } = {},
): ConversationChapterPage<ConversationChapterSearchResult> {
  const limit = pageLimit(opts.limit);
  const offset = parseCursor(opts.cursor, 'search') ?? 0;
  const andMatch = buildFtsMatch(query, 'AND');
  if (!andMatch) return { items: [], next_cursor: null };
  let rows = searchRows(db, sessionId, andMatch, limit + 1, offset);
  // Preserve recall for natural-language queries while keeping exact multi-term
  // matches precise whenever at least one exists.
  if (rows.length === 0) {
    const orMatch = buildFtsMatch(query, 'OR');
    if (orMatch !== andMatch) rows = searchRows(db, sessionId, orMatch, limit + 1, offset);
  }
  const items = rows.slice(0, limit);
  return {
    items,
    next_cursor: rows.length > limit ? cursor('search', offset + limit) : null,
  };
}

export function get(db: DB, sessionId: number, chapterId: number): ConversationChapterRow | null {
  return (db.prepare(`
    SELECT * FROM coder_session_chapters WHERE session_id = ? AND id = ?
  `).get(sessionId, chapterId) as ConversationChapterRow | undefined) ?? null;
}

export function listSource(
  db: DB,
  sessionId: number,
  chapterId: number,
  opts: { limit?: number; cursor?: string | null } = {},
): ConversationChapterPage<CoderMessageRow> {
  const chapter = get(db, sessionId, chapterId);
  if (!chapter) return { items: [], next_cursor: null };
  const limit = pageLimit(opts.limit);
  const afterId = parseCursor(opts.cursor, 'message') ?? 0;
  const rows = db.prepare(`
    SELECT * FROM coder_messages
    WHERE session_id = ?
      AND id >= ? AND id <= ? AND id > ?
    ORDER BY id ASC
    LIMIT ?
  `).all(
    sessionId, chapter.start_message_id, chapter.end_message_id,
    afterId, limit + 1,
  ) as CoderMessageRow[];
  const items = rows.slice(0, limit);
  return {
    items,
    next_cursor: rows.length > limit && items.length > 0
      ? cursor('message', items[items.length - 1].id)
      : null,
  };
}
