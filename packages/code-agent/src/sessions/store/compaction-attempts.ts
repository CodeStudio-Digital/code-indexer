import type { Database as DB } from 'better-sqlite3';
import type {
  CompactionAttemptRow,
  ConversationChapterStatus,
  FinishCompactionAttemptInput,
  StartCompactionAttemptInput,
} from '@mcp/code-agent/sessions/types.js';

function tableExists(db: DB, table: string): boolean {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table);
}

/** Begin one crash-visible attempt and mark the triggering turn immediately. */
export function start(db: DB, input: StartCompactionAttemptInput): number | null {
  if (!tableExists(db, 'coder_compaction_attempts')) return null;
  try {
    const result = db.prepare(`
      INSERT INTO coder_compaction_attempts (
        session_id, run_id, turn, turn_telemetry_id, trigger,
        provider_chain_json, prompt_tokens_before, history_chars_before
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.session_id,
      input.run_id,
      input.turn,
      input.turn_telemetry_id ?? null,
      input.trigger ?? '',
      JSON.stringify(input.provider_chain ?? []),
      input.prompt_tokens_before ?? null,
      input.history_chars_before ?? null,
    );
    if (input.turn_telemetry_id != null) {
      db.prepare('UPDATE coder_turn_telemetry SET compaction_triggered = 1 WHERE id = ?')
        .run(input.turn_telemetry_id);
    }
    return Number(result.lastInsertRowid);
  } catch (error) {
    console.warn(`[coder] startCompactionAttempt failed: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

/** Finalize an attempt and repair the legacy per-turn booleans for compatibility. */
export function finish(db: DB, id: number | null, input: FinishCompactionAttemptInput): void {
  if (id == null || !tableExists(db, 'coder_compaction_attempts')) return;
  try {
    const summarizerRan = input.summarizer_ran ? 1 : 0;
    db.prepare(`
      UPDATE coder_compaction_attempts
      SET status = ?, strategy = ?, summarizer_ran = ?,
          summary_provider = ?, summary_model = ?,
          history_chars_after = ?, pruned_messages = ?,
          chapter_id = ?, boundary_id = ?, error_message = ?,
          finished_at = datetime('now')
      WHERE id = ?
    `).run(
      input.status,
      input.strategy,
      summarizerRan,
      input.summary_provider ?? null,
      input.summary_model ?? null,
      input.history_chars_after ?? null,
      input.pruned_messages ?? 0,
      input.chapter_id ?? null,
      input.boundary_id ?? null,
      input.error_message?.slice(0, 2_000) ?? null,
      id,
    );
    db.prepare(`
      UPDATE coder_turn_telemetry
      SET compaction_triggered = 1,
          summarizer_ran = CASE WHEN ? = 1 THEN 1 ELSE summarizer_ran END
      WHERE id = (SELECT turn_telemetry_id FROM coder_compaction_attempts WHERE id = ?)
    `).run(summarizerRan, id);
  } catch (error) {
    console.warn(`[coder] finishCompactionAttempt failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export function latest(db: DB, sessionId: number): CompactionAttemptRow | null {
  if (!tableExists(db, 'coder_compaction_attempts')) return null;
  return (db.prepare(`
    SELECT * FROM coder_compaction_attempts
    WHERE session_id = ? ORDER BY id DESC LIMIT 1
  `).get(sessionId) as CompactionAttemptRow | undefined) ?? null;
}

export function chapterStatus(db: DB, sessionId: number): ConversationChapterStatus {
  const session = db.prepare(`
    SELECT COALESCE(summary_boundary_id, 0) AS boundary_id
    FROM coder_sessions WHERE id = ?
  `).get(sessionId) as { boundary_id: number } | undefined;
  if (!session) throw new Error(`session ${sessionId} not found`);

  const counts = db.prepare(`
    SELECT COUNT(*) AS chapter_count,
           COALESCE(SUM(CASE WHEN chapter_kind = 'context' THEN 1 ELSE 0 END), 0) AS context_chapters,
           COALESCE(SUM(CASE WHEN chapter_kind = 'milestone' THEN 1 ELSE 0 END), 0) AS milestone_chapters,
           COALESCE(SUM(CASE WHEN chapter_kind = 'rebuild' THEN 1 ELSE 0 END), 0) AS rebuilt_chapters
    FROM coder_session_chapters
    WHERE session_id = ? AND superseded_at IS NULL
  `).get(sessionId) as {
    chapter_count: number;
    context_chapters: number;
    milestone_chapters: number;
    rebuilt_chapters: number;
  };
  const unsummarized = db.prepare(`
    SELECT COUNT(*) AS count FROM coder_messages
    WHERE session_id = ? AND id > ?
  `).get(sessionId, session.boundary_id) as { count: number };

  const attemptCounts = tableExists(db, 'coder_compaction_attempts')
    ? db.prepare(`
        SELECT COUNT(*) AS attempts,
          COALESCE(SUM(CASE
            WHEN summarizer_ran = 1 AND strategy = 'summarizer'
              AND status IN ('summarized', 'checkpoint_failed') THEN 1 ELSE 0 END), 0) AS summarized,
          COALESCE(SUM(status = 'deterministic_fallback'), 0) AS deterministic_fallbacks,
          COALESCE(SUM(status = 'checkpoint_failed'), 0) AS checkpoint_failures,
          COALESCE(SUM(status = 'noop'), 0) AS noops,
          COALESCE(SUM(CASE WHEN error_message IS NOT NULL THEN 1 ELSE 0 END), 0) AS failures
        FROM coder_compaction_attempts WHERE session_id = ?
      `).get(sessionId) as ConversationChapterStatus['counters']
    : { attempts: 0, summarized: 0, deterministic_fallbacks: 0, checkpoint_failures: 0, noops: 0, failures: 0 };
  const lastAttempt = latest(db, sessionId);
  const degraded = lastAttempt?.status === 'deterministic_fallback'
    || lastAttempt?.status === 'checkpoint_failed'
    || lastAttempt?.status === 'started'
    || (lastAttempt?.status === 'noop' && !!lastAttempt.error_message);

  return {
    state: degraded ? 'degraded' : counts.chapter_count > 0 ? 'healthy' : 'empty',
    boundary_id: session.boundary_id || null,
    unsummarized_messages: unsummarized.count,
    chapter_count: counts.chapter_count,
    context_chapters: counts.context_chapters,
    milestone_chapters: counts.milestone_chapters,
    rebuilt_chapters: counts.rebuilt_chapters,
    counters: attemptCounts,
    last_attempt: lastAttempt,
  };
}
