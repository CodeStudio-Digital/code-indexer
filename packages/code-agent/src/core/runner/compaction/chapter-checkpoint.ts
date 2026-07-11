import type { AgentMessage } from '@mcp/code-agent/core/messages.js';
import {
  renderChapterV3,
  renderResumeV3,
  type CompactionSummaryV3,
} from '@mcp/code-agent/core/summarizer.js';
import type { SessionStore } from '@mcp/code-agent/sessions/store.js';
import type { CommitConversationChapterResult } from '@mcp/code-agent/sessions/types.js';

export interface PersistChapterCheckpointInput {
  store: SessionStore;
  sessionId: number;
  summary: CompactionSummaryV3;
  headMessages: readonly AgentMessage[];
  source?: 'auto' | 'manual';
  trigger?: string;
  chaptersEnabled?: boolean;
  autoContinues?: number;
}

export type PersistChapterCheckpointResult = CommitConversationChapterResult | {
  status: 'noop';
  reason: 'unaligned';
  boundary_id: number;
  pruned_count: 0;
} | {
  status: 'compatibility';
  boundary_id: number;
  pruned_count: number;
};

/** Queues are process-local; the SQLite boundary CAS remains authoritative. */
const sessionQueues = new Map<number, Promise<void>>();

export async function serializeSessionCompaction<T>(
  sessionId: number,
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

function sameMessage(left: AgentMessage, right: AgentMessage): boolean {
  return left.role === right.role && JSON.stringify(left.content) === JSON.stringify(right.content);
}

/**
 * Map a summarized in-memory head onto the longest contiguous prefix of the
 * currently visible DB transcript. Synthetic resume/reminder messages may be
 * skipped, but a DB row may never be skipped: gaps must leave the boundary in
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
export function persistChapterCheckpoint(
  input: PersistChapterCheckpointInput,
): PersistChapterCheckpointResult {
  const data = input.store.loadSessionWithMessages(input.sessionId);
  if (!data) throw new Error(`session ${input.sessionId} not found`);
  const expectedBoundary = data.session.summary_boundary_id ?? 0;
  const matched = alignedDurablePrefix(data.messages, input.headMessages);
  if (matched <= 0) {
    return {
      status: 'noop',
      reason: 'unaligned',
      boundary_id: expectedBoundary,
      pruned_count: 0,
    };
  }

  const rows = data.message_rows.slice(0, matched);
  const start = rows[0]!.id;
  const end = rows[rows.length - 1]!.id;
  const resumeText = renderResumeV3(input.summary);

  // Operational rollback keeps the one-call V3 pipeline but stores only the
  // compatibility resume/boundary, leaving existing chapter rows untouched.
  if (input.chaptersEnabled === false) {
    const committed = input.store.setCompactionBoundary(
      input.sessionId,
      resumeText,
      end,
      input.source ?? 'auto',
    );
    return {
      status: 'compatibility',
      boundary_id: committed.boundary_id,
      pruned_count: committed.pruned_count,
    };
  }

  return input.store.commitConversationChapter({
    sessionId: input.sessionId,
    expectedBoundaryId: expectedBoundary,
    startMessageId: start,
    endMessageId: end,
    source: input.source ?? 'auto',
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
