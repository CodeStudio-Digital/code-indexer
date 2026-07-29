import type { AgentMessage } from '@mcp/code-agent/core/messages.js';
import {
  renderChapterV3,
  renderResumeV3,
  type CompactionSummaryV3,
} from '@mcp/code-agent/core/summarizer.js';
import type {
  FsCommitConversationChapterResult,
  FsSessionStore,
} from '@mcp/code-agent/sessions/fs-store/index.js';
import type { SessionId } from '@mcp/session-storage';

export interface PersistChapterCheckpointInput {
  store: FsSessionStore;
  sessionId: SessionId;
  summary: CompactionSummaryV3;
  headMessages: readonly AgentMessage[];
  source?: 'auto' | 'manual';
  chapterKind?: 'context' | 'milestone';
  trigger?: string;
  chaptersEnabled?: boolean;
  autoContinues?: number;
}

export type PersistChapterCheckpointResult = FsCommitConversationChapterResult | {
  status: 'noop';
  reason: 'unaligned' | 'unsafe_tool_boundary';
  boundary_seq: number;
  pruned_count: 0;
} | {
  status: 'compatibility';
  boundary_seq: number;
  pruned_count: number;
};

/** Process-local ordering complements the bundle's cross-process writer lease. */
const sessionQueues = new Map<string, Promise<void>>();

export async function serializeSessionCompaction<T>(
  sessionId: SessionId,
  task: () => Promise<T>,
): Promise<T> {
  const previous = sessionQueues.get(sessionId) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => { release = resolve; });
  const queued = previous.catch(() => undefined).then(() => current);
  sessionQueues.set(sessionId, queued);
  await previous.catch(() => undefined);
  try {
    return await task();
  } finally {
    release();
    if (sessionQueues.get(sessionId) === queued) sessionQueues.delete(sessionId);
  }
}

/**
 * Persistence rebuilds tool_result blocks from the audit row, so operational
 * metadata such as `originalSize` can legitimately differ from the live block
 * even when the model saw the exact same content. Compare a stable semantic
 * representation instead of object insertion order / persistence-only fields.
 */
function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => canonicalValue(item));
  if (!value || typeof value !== 'object') return value;
  const entries = Object.entries(value as Record<string, unknown>)
    .map(([entryKey, entryValue]) => [entryKey, canonicalValue(entryValue)] as const)
    .filter(([, entryValue]) => entryValue !== undefined)
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
  return Object.fromEntries(entries);
}

function canonicalContent(message: AgentMessage): unknown {
  return message.content.map((block) => {
    const normalized = { ...block } as Record<string, unknown>;
    if (block.type === 'tool_result') {
      // Persistence reconstructs this size from audit columns; it is not model
      // content. Keep every nested `originalSize` in tool inputs semantic.
      delete normalized.originalSize;
      if (normalized.is_error == null) normalized.is_error = false;
    }
    return canonicalValue(normalized);
  });
}

function sameMessage(left: AgentMessage, right: AgentMessage): boolean {
  return left.role === right.role
    && JSON.stringify(canonicalContent(left)) === JSON.stringify(canonicalContent(right));
}

/**
 * Recede an aligned durable-transcript prefix when it would archive one side of a
 * tool_use/tool_result pair. Unlike the provider-tail cutoff helper this may
 * never advance over an unseen row: duplicate raw text is safe, a summary gap
 * is not.
 */
export function recedePrefixToToolPairBoundary(
  messages: readonly AgentMessage[],
  matched: number,
): number {
  let safe = Math.max(0, Math.min(matched, messages.length));
  if (safe <= 0 || safe >= messages.length) return safe;

  const uses = new Map<string, number>();
  const results = new Map<string, number>();
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    for (const block of message.content) {
      if (message.role === 'assistant' && block.type === 'tool_use') {
        uses.set(block.id, index);
      } else if (message.role === 'tool' && block.type === 'tool_result' && block.tool_use_id) {
        results.set(block.tool_use_id, index);
      }
    }
  }

  // Receding for one pair can expose another crossing pair, so converge.
  let changed = true;
  while (changed) {
    changed = false;
    for (const [id, useIndex] of uses) {
      const resultIndex = results.get(id);
      if (resultIndex == null) continue;
      const earlier = Math.min(useIndex, resultIndex);
      const later = Math.max(useIndex, resultIndex);
      if (earlier < safe && later >= safe) {
        safe = earlier;
        changed = true;
      }
    }
  }
  return safe;
}

/**
 * Map a summarized in-memory head onto the longest contiguous prefix of the
 * currently visible bundle transcript. Synthetic resume/reminder messages may
 * be skipped, but a durable record may never be skipped: gaps leave the boundary in
 * place rather than archive text the summary did not see.
 */
export function alignedDurablePrefix(
  durableMessages: readonly AgentMessage[],
  headMessages: readonly AgentMessage[],
): number {
  let headIndex = 0;
  let matched = 0;
  for (const durable of durableMessages) {
    while (headIndex < headMessages.length && !sameMessage(durable, headMessages[headIndex])) {
      headIndex += 1;
    }
    if (headIndex >= headMessages.length) break;
    matched += 1;
    headIndex += 1;
  }
  return matched;
}

/**
 * Append one immutable chapter and advance the cached resume/boundary in the
 * same transaction. The summary has already been generated; no provider call
 * occurs here.
 */
export async function persistChapterCheckpoint(
  input: PersistChapterCheckpointInput,
): Promise<PersistChapterCheckpointResult> {
  const data = await input.store.loadSessionWithMessages(input.sessionId);
  if (!data) throw new Error(`session ${input.sessionId} not found`);
  const expectedBoundary = data.session.summary_boundary_id ?? 0;
  const aligned = alignedDurablePrefix(data.messages, input.headMessages);
  if (aligned <= 0) {
    return {
      status: 'noop',
      reason: 'unaligned',
      boundary_seq: expectedBoundary,
      pruned_count: 0,
    };
  }
  const matched = recedePrefixToToolPairBoundary(data.messages, aligned);
  if (matched <= 0) {
    return {
      status: 'noop',
      reason: 'unsafe_tool_boundary',
      boundary_seq: expectedBoundary,
      pruned_count: 0,
    };
  }

  const rows = data.message_rows.slice(0, matched);
  const start = rows[0]!.seq;
  const end = rows[rows.length - 1]!.seq;
  const resumeText = renderResumeV3(input.summary);

  // Operational rollback keeps the one-call V3 pipeline but stores only the
  // compatibility resume/boundary, leaving existing chapter rows untouched.
  if (input.chaptersEnabled === false) {
    const committed = await input.store.setCompactionBoundary(
      input.sessionId,
      resumeText,
      end,
      input.source ?? 'auto',
    );
    return {
      status: 'compatibility',
      boundary_seq: committed.boundary_seq,
      pruned_count: committed.pruned_count,
    };
  }

  return input.store.commitConversationChapter({
    sessionId: input.sessionId,
    expectedBoundarySeq: expectedBoundary,
    startMessageSeq: start,
    endMessageSeq: end,
    source: input.source ?? 'auto',
    chapterKind: input.chapterKind ?? (input.trigger?.startsWith('milestone:') ? 'milestone' : 'context'),
    trigger: input.trigger ?? 'context_threshold',
    title: input.summary.chapter.title || `Conversation chapter through message ${end}`,
    chapterJson: JSON.stringify(input.summary.chapter),
    chapterText: renderChapterV3(input.summary),
    resumeJson: JSON.stringify(input.summary.resume),
    resumeText,
    version: input.summary.version,
    metricsJson: JSON.stringify({
      ...(input.summary.metrics ?? {}),
      auto_continues: input.autoContinues ?? 0,
      trigger: input.trigger ?? 'context_threshold',
    }),
  });
}
