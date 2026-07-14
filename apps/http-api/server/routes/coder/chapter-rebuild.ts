import type { ServerDeps } from '../../deps.js';
import {
  renderChapterV3,
  renderResumeV3,
  type CompactionResumeV3,
} from '@mcp/code-agent/core/summarizer.js';
import type { AgentMessage } from '@mcp/code-agent/core/messages.js';
import type { CoderMessageRow, RebuiltConversationChapterInput } from '@mcp/code-agent/sessions/types.js';
import type { RebuildConversationChaptersInput } from './chapters.js';
import { resolveCompactionProviders, summarizeReliably } from './compaction-summary.js';

const MAX_CHUNK_MESSAGES = 50;
const MAX_CHUNK_CHARS = 60_000;

function rowToMessage(row: CoderMessageRow): AgentMessage {
  const content = JSON.parse(row.content_json) as AgentMessage['content'];
  const selected = row.selected_skill_ids_json
    ? JSON.parse(row.selected_skill_ids_json) as string[]
    : undefined;
  return {
    role: row.role,
    content,
    ...(row.is_meta ? { isMeta: true } : {}),
    ...(selected?.length ? { selectedSkillIds: selected } : {}),
  };
}

interface RowChunk {
  rows: CoderMessageRow[];
  chars: number;
}

function containsToolUse(row: CoderMessageRow): boolean {
  if (row.role !== 'assistant') return false;
  try {
    const content = JSON.parse(row.content_json) as Array<{ type?: string }>;
    return Array.isArray(content) && content.some((block) => block.type === 'tool_use');
  } catch {
    return false;
  }
}

/**
 * Pack a transcript into bounded chunks while treating one assistant tool-use
 * message plus all immediately following tool-result rows as an atomic unit.
 * A single oversized unit is allowed as its own chunk: the V3 prompt sampler
 * bounds its representation, and rejecting it would make one-user autonomous
 * sessions impossible to rebuild.
 */
export function chunkArchivedConversation(rows: readonly CoderMessageRow[]): RowChunk[] {
  if (rows.length === 0) return [];
  const units: RowChunk[] = [];
  for (let index = 0; index < rows.length;) {
    const unitRows = [rows[index]!];
    let chars = rows[index]!.content_json.length;
    if (containsToolUse(rows[index]!)) {
      let next = index + 1;
      while (next < rows.length && rows[next]!.role === 'tool') {
        unitRows.push(rows[next]!);
        chars += rows[next]!.content_json.length;
        next += 1;
      }
      index = next;
    } else {
      index += 1;
    }
    units.push({ rows: unitRows, chars });
  }

  const chunks: RowChunk[] = [];
  let current: RowChunk = { rows: [], chars: 0 };
  for (const unit of units) {
    const oversized = unit.rows.length > MAX_CHUNK_MESSAGES || unit.chars > MAX_CHUNK_CHARS;
    const exceeds = current.rows.length > 0 && (
      current.rows.length + unit.rows.length > MAX_CHUNK_MESSAGES
      || current.chars + unit.chars > MAX_CHUNK_CHARS
    );
    if (exceeds || (oversized && current.rows.length > 0)) {
      chunks.push(current);
      current = { rows: [], chars: 0 };
    }
    current.rows.push(...unit.rows);
    current.chars += unit.chars;
    if (oversized) {
      chunks.push(current);
      current = { rows: [], chars: 0 };
    }
  }
  if (current.rows.length > 0) chunks.push(current);
  return chunks;
}

export interface RebuildConversationChaptersResult {
  ok: true;
  scope: 'archived' | 'visible' | 'all';
  chunks: number;
  rebuilt: number;
  chapters_generated: number;
  failures: Array<{ start_message_id: number; end_message_id: number; error: string }>;
  superseded_legacy: number;
  first_message_id: number | null;
  last_message_id: number | null;
}

/** User-triggered, synchronous rebuild; the route serializes it with active runs. */
export async function rebuildConversationChapters(
  deps: ServerDeps,
  sessionId: number,
  input: RebuildConversationChaptersInput,
): Promise<RebuildConversationChaptersResult> {
  const session = deps.sessionStore.getSession(sessionId);
  if (!session) throw new Error(`session ${sessionId} not found`);
  const boundary = session.summary_boundary_id ?? 0;
  const scope = input.scope ?? (input.archived_only === false ? 'all' : 'archived');
  const where = scope === 'archived'
    ? 'AND id <= ?'
    : scope === 'visible'
      ? 'AND id > ?'
      : '';
  const rows = deps.sessionStore.getDb().prepare(`
    SELECT * FROM coder_messages
    WHERE session_id = ? ${where}
    ORDER BY id ASC
  `).all(...(scope === 'all' ? [sessionId] : [sessionId, boundary])) as CoderMessageRow[];
  const chunks = chunkArchivedConversation(rows);
  if (chunks.length === 0) {
    return {
      ok: true,
      scope,
      chunks: 0,
      rebuilt: 0,
      chapters_generated: 0,
      failures: [],
      superseded_legacy: 0,
      first_message_id: null,
      last_message_id: null,
    };
  }

  const { providers, options, errors: providerResolutionErrors } = await resolveCompactionProviders(
    deps,
    session,
    sessionId,
  );
  let previousResume: CompactionResumeV3 | string | null = null;
  const rebuilt: RebuiltConversationChapterInput[] = [];
  const successes: Array<{
    attemptId: number | null;
    start: number;
    end: number;
    provider: string | null;
    model: string | null;
    errors: string[];
  }> = [];
  const failures: RebuildConversationChaptersResult['failures'] = [];
  const rebuildRunId = `rebuild:${sessionId}:${Date.now()}`;

  for (const [index, chunk] of chunks.entries()) {
    const start = chunk.rows[0]!.id;
    const end = chunk.rows[chunk.rows.length - 1]!.id;
    const attemptId = deps.sessionStore.startCompactionAttempt({
      session_id: sessionId,
      run_id: rebuildRunId,
      turn: index + 1,
      trigger: `rebuild:${scope}`,
      provider_chain: providers.map((provider) => ({ provider: provider.name, model: provider.model })),
      prompt_tokens_before: Math.ceil(chunk.chars / 4),
      history_chars_before: chunk.chars,
    });
    const summarized = await summarizeReliably({
      previousResume,
      messages: chunk.rows.map(rowToMessage),
    }, providers, options, providerResolutionErrors);
    if (!summarized.summary) {
      const error = summarized.errors.join(' | ') || 'all summary providers failed';
      deps.sessionStore.finishCompactionAttempt(attemptId, {
        status: 'noop',
        strategy: 'none',
        summarizer_ran: true,
        history_chars_after: chunk.chars,
        error_message: error,
      });
      failures.push({ start_message_id: start, end_message_id: end, error });
      continue;
    }
    const summary = summarized.summary;
    previousResume = summary.resume;
    rebuilt.push({
      startMessageId: start,
      endMessageId: end,
      trigger: `user_rebuild:${scope}`,
      title: summary.chapter.title || `Conversation history ${rebuilt.length + 1}`,
      chapterJson: JSON.stringify(summary.chapter),
      chapterText: renderChapterV3(summary),
      resumeJson: JSON.stringify(summary.resume),
      resumeText: renderResumeV3(summary),
      version: summary.version,
      metricsJson: summary.metrics ? JSON.stringify(summary.metrics) : null,
      chapterKind: 'rebuild',
      advancesContextBoundary: false,
    });
    successes.push({
      attemptId,
      start,
      end,
      provider: summarized.provider,
      model: summarized.model,
      errors: summarized.errors,
    });
  }

  let result;
  try {
    result = deps.sessionStore.insertRebuiltConversationChapters(sessionId, rebuilt);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    for (const success of successes) {
      deps.sessionStore.finishCompactionAttempt(success.attemptId, {
        status: 'checkpoint_failed',
        strategy: 'summarizer',
        summarizer_ran: true,
        summary_provider: success.provider,
        summary_model: success.model,
        history_chars_after: 0,
        error_message: message,
      });
    }
    throw error;
  }
  for (const success of successes) {
    const chapter = result.items.find((item) => (
      item.start_message_id === success.start && item.end_message_id === success.end
    ));
    deps.sessionStore.finishCompactionAttempt(success.attemptId, {
      status: 'summarized',
      strategy: 'summarizer',
      summarizer_ran: true,
      summary_provider: success.provider,
      summary_model: success.model,
      history_chars_after: 0,
      pruned_messages: 0,
      chapter_id: chapter?.id ?? null,
      boundary_id: boundary || null,
      error_message: success.errors.join(' | ') || null,
    });
  }

  return {
    ok: true,
    scope,
    chunks: chunks.length,
    rebuilt: result.items.length,
    chapters_generated: result.items.length,
    failures,
    superseded_legacy: result.superseded_count,
    first_message_id: rebuilt[0]?.startMessageId ?? null,
    last_message_id: rebuilt[rebuilt.length - 1]?.endMessageId ?? null,
  };
}
