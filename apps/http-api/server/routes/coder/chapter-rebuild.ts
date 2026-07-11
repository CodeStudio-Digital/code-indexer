import type { ServerDeps } from '../../deps.js';
import { createCoderProvider } from '@mcp/services/providers/factory.js';
import {
  renderChapterV3,
  renderResumeV3,
  summarizeSpanV3,
  type CompactionResumeV3,
} from '@mcp/code-agent/core/summarizer.js';
import type { AgentMessage } from '@mcp/code-agent/core/messages.js';
import type { CoderMessageRow, RebuiltConversationChapterInput } from '@mcp/code-agent/sessions/types.js';
import type { RebuildConversationChaptersInput } from './chapters.js';

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

/** Pack complete user turns so every new chunk starts at a user boundary. */
export function chunkArchivedConversation(rows: readonly CoderMessageRow[]): RowChunk[] {
  if (rows.length === 0) return [];
  if (rows[0].role !== 'user') {
    throw new Error('archived transcript does not start on a user boundary');
  }
  const turns: RowChunk[] = [];
  let turn: CoderMessageRow[] = [];
  let chars = 0;
  for (const row of rows) {
    if (row.role === 'user' && turn.length > 0) {
      turns.push({ rows: turn, chars });
      turn = [];
      chars = 0;
    }
    turn.push(row);
    chars += row.content_json.length;
  }
  if (turn.length > 0) turns.push({ rows: turn, chars });

  const chunks: RowChunk[] = [];
  let current: RowChunk = { rows: [], chars: 0 };
  for (const unit of turns) {
    if (unit.rows.length > MAX_CHUNK_MESSAGES || unit.chars > MAX_CHUNK_CHARS) {
      throw new Error(
        `one user turn exceeds the rebuild chunk limit (${unit.rows.length} messages/${unit.chars} chars)`,
      );
    }
    const exceeds = current.rows.length > 0 && (
      current.rows.length + unit.rows.length > MAX_CHUNK_MESSAGES
      || current.chars + unit.chars > MAX_CHUNK_CHARS
    );
    if (exceeds) {
      chunks.push(current);
      current = { rows: [], chars: 0 };
    }
    current.rows.push(...unit.rows);
    current.chars += unit.chars;
  }
  if (current.rows.length > 0) chunks.push(current);
  return chunks;
}

/** User-triggered, synchronous rebuild; the route serializes it with active runs. */
export async function rebuildConversationChapters(
  deps: ServerDeps,
  sessionId: number,
  _input: RebuildConversationChaptersInput,
): Promise<{
  ok: true;
  rebuilt: number;
  superseded_legacy: number;
  first_message_id: number | null;
  last_message_id: number | null;
}> {
  const session = deps.sessionStore.getSession(sessionId);
  if (!session) throw new Error(`session ${sessionId} not found`);
  const boundary = session.summary_boundary_id ?? 0;
  if (boundary <= 0) {
    return {
      ok: true,
      rebuilt: 0,
      superseded_legacy: 0,
      first_message_id: null,
      last_message_id: null,
    };
  }

  const rows = deps.sessionStore.getDb().prepare(`
    SELECT * FROM coder_messages
    WHERE session_id = ? AND id <= ?
    ORDER BY id ASC
  `).all(sessionId, boundary) as CoderMessageRow[];
  const chunks = chunkArchivedConversation(rows);
  if (chunks.length === 0) {
    return {
      ok: true,
      rebuilt: 0,
      superseded_legacy: 0,
      first_message_id: null,
      last_message_id: null,
    };
  }

  const binding = await deps.pipelineProviderResolver.resolveOrNull(
    'code-agent',
    'compaction',
    { sessionId },
  );
  const provider = binding
    ? await createCoderProvider(binding.provider.id, binding.modelId)
    : await createCoderProvider(session.provider, session.model);

  let previousResume: CompactionResumeV3 | string | null = null;
  const rebuilt: RebuiltConversationChapterInput[] = [];
  for (const chunk of chunks) {
    const summary = await summarizeSpanV3({
      previousResume,
      messages: chunk.rows.map(rowToMessage),
    }, provider);
    if (!summary) {
      throw new Error(
        `summarizer returned no result for messages ${chunk.rows[0]!.id}-${chunk.rows[chunk.rows.length - 1]!.id}`,
      );
    }
    previousResume = summary.resume;
    rebuilt.push({
      startMessageId: chunk.rows[0]!.id,
      endMessageId: chunk.rows[chunk.rows.length - 1]!.id,
      trigger: 'user_rebuild',
      title: summary.chapter.title || `Conversation history ${rebuilt.length + 1}`,
      chapterJson: JSON.stringify(summary.chapter),
      chapterText: renderChapterV3(summary),
      resumeJson: JSON.stringify(summary.resume),
      resumeText: renderResumeV3(summary),
      version: summary.version,
      metricsJson: summary.metrics ? JSON.stringify(summary.metrics) : null,
    });
  }

  const result = deps.sessionStore.insertRebuiltConversationChapters(sessionId, rebuilt);
  return {
    ok: true,
    rebuilt: result.items.length,
    superseded_legacy: result.superseded_count,
    first_message_id: rebuilt[0]?.startMessageId ?? null,
    last_message_id: rebuilt[rebuilt.length - 1]?.endMessageId ?? null,
  };
}
