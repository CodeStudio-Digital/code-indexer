import type { Database as DB } from 'better-sqlite3';
import type {
  ConversationChapterRow,
  ConversationChapterSource,
  InsertRebuiltConversationChaptersResult,
  RebuiltConversationChapterInput,
} from '@mcp/code-agent/sessions/types.js';

function currentBoundary(db: DB, sessionId: number): number {
  const row = db.prepare(`
    SELECT COALESCE(summary_boundary_id, 0) AS boundary
    FROM coder_sessions WHERE id = ?
  `).get(sessionId) as { boundary: number } | undefined;
  if (!row) throw new Error(`session ${sessionId} not found`);
  return row.boundary;
}

/** Replace legacy coverage without moving the live boundary or counters. */
export function insertRebuilt(
  db: DB,
  sessionId: number,
  chapters: readonly RebuiltConversationChapterInput[],
): InsertRebuiltConversationChaptersResult {
  if (chapters.length === 0) return { items: [], superseded_count: 0 };
  const ordered = [...chapters].sort((a, b) => a.startMessageId - b.startMessageId);
  let previousEnd = 0;
  for (const chapter of ordered) {
    const start = chapter.startMessageId;
    const end = chapter.endMessageId;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start <= previousEnd || end < start) {
      throw new RangeError('rebuilt chapter ranges must be valid and non-overlapping');
    }
    if (!chapter.title.trim() || !chapter.chapterText.trim() || !chapter.resumeText.trim()) {
      throw new Error('rebuilt chapter title, chapterText, and resumeText must not be empty');
    }
    if (!Number.isSafeInteger(chapter.version) || chapter.version <= 0) {
      throw new RangeError(`invalid rebuilt chapter version ${chapter.version}`);
    }
    previousEnd = end;
  }

  const tx = db.transaction((): InsertRebuiltConversationChaptersResult => {
    const boundary = currentBoundary(db, sessionId);
    if (ordered.some((chapter) => chapter.advancesContextBoundary === true)
      && ordered[ordered.length - 1].endMessageId > boundary) {
      throw new RangeError('rebuilt chapters cannot extend beyond the durable boundary');
    }
    for (const chapter of ordered) {
      const span = db.prepare(`
        SELECT COUNT(*) AS count, MIN(id) AS first_id, MAX(id) AS last_id
        FROM coder_messages
        WHERE session_id = ? AND id >= ? AND id <= ?
      `).get(sessionId, chapter.startMessageId, chapter.endMessageId) as {
        count: number; first_id: number | null; last_id: number | null;
      };
      if (span.count === 0 || span.first_id !== chapter.startMessageId || span.last_id !== chapter.endMessageId) {
        throw new RangeError(
          `rebuilt chapter ${chapter.startMessageId}..${chapter.endMessageId} is not backed by session messages`,
        );
      }
    }

    const existing = db.prepare(`
      SELECT * FROM coder_session_chapters
      WHERE session_id = ? AND source = 'rebuild' AND superseded_at IS NULL
      ORDER BY start_message_id
    `).all(sessionId) as ConversationChapterRow[];
    const exactRetry = existing.length === ordered.length && existing.every((row, index) =>
      row.start_message_id === ordered[index].startMessageId &&
      row.end_message_id === ordered[index].endMessageId
    );
    if (exactRetry) return { items: existing, superseded_count: 0 };

    const first = ordered[0].startMessageId;
    const last = ordered[ordered.length - 1].endMessageId;
    // Navigation-only rebuilds may overlap durable context chapters. They do
    // not move the model boundary and will be superseded automatically when a
    // newer context checkpoint covers their range.
    const superseded = db.prepare(`
      UPDATE coder_session_chapters
      SET superseded_at = datetime('now')
      WHERE session_id = ? AND source IN ('legacy', 'rebuild') AND superseded_at IS NULL
        AND start_message_id <= ? AND end_message_id >= ?
    `).run(sessionId, last, first).changes;

    let ordinal = (db.prepare(`
      SELECT COALESCE(MAX(ordinal), 0) AS ordinal
      FROM coder_session_chapters WHERE session_id = ?
    `).get(sessionId) as { ordinal: number }).ordinal;
    const insert = db.prepare(`
      INSERT INTO coder_session_chapters (
        session_id, ordinal, start_message_id, end_message_id,
        source, trigger, title, chapter_kind, advances_context_boundary,
        chapter_json, chapter_text, resume_json, resume_text,
        version, metrics_json
      ) VALUES (?, ?, ?, ?, 'rebuild', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const items: ConversationChapterRow[] = [];
    for (const chapter of ordered) {
      ordinal += 1;
      const result = insert.run(
        sessionId, ordinal, chapter.startMessageId, chapter.endMessageId,
        chapter.trigger, chapter.title,
        chapter.chapterKind ?? 'rebuild', chapter.advancesContextBoundary === true ? 1 : 0,
        chapter.chapterJson, chapter.chapterText,
        chapter.resumeJson, chapter.resumeText, chapter.version, chapter.metricsJson ?? null,
      );
      items.push(db.prepare('SELECT * FROM coder_session_chapters WHERE id = ?')
        .get(Number(result.lastInsertRowid)) as ConversationChapterRow);
    }
    return { items, superseded_count: superseded };
  });
  return tx();
}

export function supersede(
  db: DB,
  sessionId: number,
  opts: { source?: ConversationChapterSource; throughEndMessageId?: number } = {},
): number {
  return db.prepare(`
    UPDATE coder_session_chapters
    SET superseded_at = COALESCE(superseded_at, datetime('now'))
    WHERE session_id = ? AND superseded_at IS NULL
      AND (? IS NULL OR source = ?)
      AND (? IS NULL OR end_message_id <= ?)
  `).run(
    sessionId, opts.source ?? null, opts.source ?? null,
    opts.throughEndMessageId ?? null, opts.throughEndMessageId ?? null,
  ).changes;
}

function deriveMessageIdMap(db: DB, fromSessionId: number, toSessionId: number): Map<number, number> {
  const source = db.prepare('SELECT id FROM coder_messages WHERE session_id = ? ORDER BY id')
    .all(fromSessionId) as Array<{ id: number }>;
  const target = db.prepare('SELECT id FROM coder_messages WHERE session_id = ? ORDER BY id')
    .all(toSessionId) as Array<{ id: number }>;
  const map = new Map<number, number>();
  for (let i = 0; i < Math.min(source.length, target.length); i++) map.set(source[i].id, target[i].id);
  return map;
}

/** Copy chapters whose complete source span exists in the target transcript. */
export function copy(
  db: DB,
  fromSessionId: number,
  toSessionId: number,
  idMap?: ReadonlyMap<number, number>,
): number {
  const tx = db.transaction(() => {
    currentBoundary(db, fromSessionId);
    currentBoundary(db, toSessionId);
    const map = idMap ?? deriveMessageIdMap(db, fromSessionId, toSessionId);
    const source = db.prepare(`
      SELECT * FROM coder_session_chapters WHERE session_id = ? ORDER BY ordinal
    `).all(fromSessionId) as ConversationChapterRow[];
    let ordinal = (db.prepare(`
      SELECT COALESCE(MAX(ordinal), 0) AS ordinal
      FROM coder_session_chapters WHERE session_id = ?
    `).get(toSessionId) as { ordinal: number }).ordinal;
    const insert = db.prepare(`
      INSERT INTO coder_session_chapters (
        session_id, ordinal, start_message_id, end_message_id,
        source, trigger, title, chapter_kind, advances_context_boundary,
        chapter_json, chapter_text, resume_json,
        resume_text, version, metrics_json, created_at, superseded_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    let copied = 0;
    let lastLive: { end: number; resume: string } | null = null;
    for (const chapter of source) {
      const mappedStart = map.get(chapter.start_message_id);
      const mappedEnd = map.get(chapter.end_message_id);
      if (mappedStart == null || mappedEnd == null) continue;
      ordinal += 1;
      insert.run(
        toSessionId, ordinal, mappedStart, mappedEnd, chapter.source, chapter.trigger,
        chapter.title, chapter.chapter_kind, chapter.advances_context_boundary,
        chapter.chapter_json, chapter.chapter_text, chapter.resume_json,
        chapter.resume_text, chapter.version, chapter.metrics_json,
        chapter.created_at, chapter.superseded_at,
      );
      copied += 1;
      if (chapter.superseded_at == null && chapter.advances_context_boundary === 1) {
        lastLive = { end: mappedEnd, resume: chapter.resume_text };
      }
    }
    if (lastLive) {
      db.prepare(`
        UPDATE coder_sessions
        SET summary_boundary_id = ?, compaction_summary = ?,
            last_response_id = NULL, last_response_message_count = NULL
        WHERE id = ?
      `).run(lastLive.end, lastLive.resume, toSessionId);
    }
    return copied;
  });
  return tx();
}

/** Invalidate chapters intersecting a rollback and restore the prior resume. */
export function rollback(db: DB, sessionId: number, fromMessageId: number): number {
  const tx = db.transaction(() => {
    const changed = db.prepare(`
      UPDATE coder_session_chapters
      SET superseded_at = COALESCE(superseded_at, datetime('now'))
      WHERE session_id = ? AND superseded_at IS NULL AND end_message_id >= ?
    `).run(sessionId, fromMessageId).changes;
    const previous = db.prepare(`
      SELECT end_message_id, resume_text FROM coder_session_chapters
      WHERE session_id = ? AND superseded_at IS NULL
        AND advances_context_boundary = 1 AND end_message_id < ?
      ORDER BY ordinal DESC LIMIT 1
    `).get(sessionId, fromMessageId) as { end_message_id: number; resume_text: string } | undefined;
    db.prepare(`
      UPDATE coder_sessions
      SET summary_boundary_id = ?, compaction_summary = ?,
          last_response_id = NULL, last_response_message_count = NULL
      WHERE id = ?
    `).run(previous?.end_message_id ?? null, previous?.resume_text ?? null, sessionId);
    return changed;
  });
  return tx();
}
