import { stat } from 'node:fs/promises';
import { materializeChapterMessage } from '../chapter-transcript.js';
import { sessionJournalPath } from '../session-journal-path.js';
import { highestMessageSeqFromTail } from './conversation-tail.js';
export { reverseCommittedConversationCommits } from './conversation-tail.js';
import type { AgentMessage } from '@mcp/provider-sdk';
import {
  assertContainedPath,
  assertPathHasNoLinks,
  type SessionId,
} from '@mcp/session-storage';
import {
  extractText,
  hydrateMessage,
  messageRow,
  projectConversation,
  type ProjectedStoredMessage,
} from './conversation-codec.js';
import { readChapterBoundarySync } from './conversation-chapter-codec.js';
import { compactionBoundary, finiteNumber } from './session-projection.js';
import { FsSessionDirectory } from './session-directory.js';
import { attachmentPage, readAttachment } from './session-attachments.js';
import { sideMessageText } from './side-chat-context.js';
import type { FsCoderMessageRow, FsMessagePage, FsSessionWithMessages } from './types.js';
import type { FsToolOutcomeState } from './tool-outcome-types.js';
import type { FsConversationChapterSourcePage } from './history-metrics-types.js';
import { queryConversationProjection, type FsConversationProjection,
  type FsConversationProjectionQuery } from './conversation-projection-query.js';

interface HydratedConversation {
  unresolved_tool_outcomes?: string[];
  resolved_tool_outcomes?: string[];
  tool_outcome_state?: FsToolOutcomeState;
  entry: Awaited<ReturnType<FsSessionDirectory['requireEntry']>>;
  session: ReturnType<FsSessionDirectory['map']>;
  rows: FsCoderMessageRow[];
  messages: AgentMessage[];
  selection?: FsConversationProjection['selection'];
}

interface StoredConversation extends HydratedConversation {
  stored: Map<number, ProjectedStoredMessage>;
  revision: string;
}

export class FsConversationReader {
  private hydratedCache: {
    key: string;
    value: StoredConversation;
    expiresAt: number;
  } | null = null;
  private readonly hydratedInFlight = new Map<string, Promise<StoredConversation>>();

  constructor(private readonly directory: FsSessionDirectory) {}

  private async projection(id: SessionId | string): Promise<StoredConversation> {
    const entry = await this.directory.requireEntry(id);
    const conversationPath = sessionJournalPath(entry.location.bundle_path);
    let fileSignature = 'missing';
    try {
      const stats = await stat(conversationPath);
      fileSignature = `${stats.size}:${stats.mtimeMs}`;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const key = [
      String(entry.session.id),
      fileSignature,
      entry.session.updated_at,
      entry.state?.updated_at ?? '',
    ].join(':');
    if (
      this.hydratedCache?.key === key
      && this.hydratedCache.expiresAt >= Date.now()
    ) return this.hydratedCache.value;
    const existing = this.hydratedInFlight.get(key);
    if (existing) return existing;

    const pending = this.hydrateEntry(entry);
    this.hydratedInFlight.set(key, pending);
    try {
      const value = await pending;
      // Keep only the most recent projection and only long enough for one HTTP
      // detail request's tail/count/archive/preceding lookups to share it.
      this.hydratedCache = { key, value, expiresAt: Date.now() + 1_000 };
      return value;
    } finally {
      if (this.hydratedInFlight.get(key) === pending) {
        this.hydratedInFlight.delete(key);
      }
    }
  }

  private async hydrated(id: SessionId | string, query?: FsConversationProjectionQuery, forProvider = false): Promise<HydratedConversation> {
    const value = await this.projection(id);
    // Legacy hydration reconciles chapter commits with state.json once. Reuse
    // that boundary, including a crash between the chapter and state commits.
    const resolved = query && 'boundary' in query && !(query.kind === 'before' && query.includeArchived)
      ? { ...query, boundary: compactionBoundary(value.session.state) } : query;
    const selected = resolved ? queryConversationProjection(value, resolved) : value;
    // Choose metadata first. Counts never open blobs, and a 40-message preview
    // must not hydrate attachments/tool outputs from the entire conversation.
    const messages = selected.rows.map(row => hydrateMessage(value.entry.location, materializeChapterMessage(value.stored.get(row.seq)!), forProvider));
    const rows = selected.rows.map((row, index) => messageRow(value.entry.session.id, value.stored.get(row.seq)!, messages[index]!));
    return { ...value, ...selected, messages, rows };
  }

  private async boundary(id: SessionId | string): Promise<number> {
    const session = await this.directory.getSession(id);
    if (!session) throw new Error('Conversation has no product session');
    return compactionBoundary(session.state);
  }

  private async hydrateEntry(
    entry: Awaited<ReturnType<FsSessionDirectory['requireEntry']>>,
  ): Promise<StoredConversation> {
    const mapped = this.directory.map(entry);
    const chapterBoundary = readChapterBoundarySync(
      entry.location.bundle_path,
      mapped.state,
    );
    const session =
      chapterBoundary.boundary_seq !==
        compactionBoundary(mapped.state) ||
      chapterBoundary.resume_text !== mapped.compaction_summary
        ? {
            ...mapped,
            summary_boundary_id:
              chapterBoundary.boundary_seq > 0
                ? chapterBoundary.boundary_seq
                : null,
            compaction_summary: chapterBoundary.resume_text,
            state: {
              ...mapped.state,
              compaction: {
                ...mapped.state.compaction,
                boundary_seq: chapterBoundary.boundary_seq,
                summary: chapterBoundary.resume_text,
              },
            },
          }
        : mapped;
    const projection = projectConversation(
      await this.directory.repository.readConversation(entry.location, 'metadata'),
    );
    // Inspect typed metadata before selecting the visible tail. Compaction is
    // not reconciliation and must not silently restore mutation authority.
    const rows = projection.storedMessages.map((stored) =>
      messageRow(entry.session.id, stored, { role: stored.role, phase: stored.phase, content: [] }),
    );
    return {
      entry,
      session,
      rows,
      messages: [],
      stored: new Map(projection.storedMessages.map(message => [message.seq, message])),
      revision: projection.commits.at(-1)?.hash ?? 'empty',
      unresolved_tool_outcomes: projection.toolOutcomes.unresolvedToolUseIds,
      resolved_tool_outcomes: projection.toolOutcomes.resolvedToolUseIds,
      tool_outcome_state: projection.toolOutcomes,
    };
  }

  async loadSession(
    id: SessionId | string,
    forProvider = false,
  ): Promise<FsSessionWithMessages | null> {
    if (!(await this.directory.entry(id))) return null;
    const result = await this.hydrated(id, { kind: 'visible', boundary: await this.boundary(id) }, forProvider);
    return {
      ...(result.unresolved_tool_outcomes ? { unresolved_tool_outcomes: result.unresolved_tool_outcomes } : {}),
      resolved_tool_outcomes: result.resolved_tool_outcomes,
      tool_outcome_state: result.tool_outcome_state,
      session: result.session,
      messages: result.messages,
      message_rows: result.rows,
    };
  }

  async sideContext(id: SessionId | string, budget: number, selectedSeq?: number) {
    const view = await this.projection(id);
    const boundary = compactionBoundary(view.session.state);
    const summary = (view.session.compaction_summary ?? '').slice(0, Math.floor(budget / 4));
    let remaining = budget - summary.length;
    let truncated = Boolean(boundary) || summary.length < (view.session.compaction_summary?.length ?? 0);
    const recent: string[] = [];
    const completedTools = new Set<string>();
    const uncertainTools = new Set(view.unresolved_tool_outcomes);
    for (let index = view.rows.length - 1; index >= 0; index--) {
      const row = view.rows[index]!;
      if (row.seq <= boundary) break;
      if (remaining < 100 || recent.length >= 64) { truncated = true; break; }
      const stored = materializeChapterMessage(view.stored.get(row.seq)!);
      if (stored.is_meta || !Array.isArray(stored.content)) continue;
      for (const block of stored.content) {
        if (block && typeof block === 'object' && !Array.isArray(block)
          && (block.type === 'tool_result' || block.type === 'tool_result_ref')
          && typeof block.tool_use_id === 'string') completedTools.add(block.tool_use_id);
      }
      // A committed request can be waiting for permission or its tool result.
      if (stored.role === 'assistant' && stored.content.some(block =>
        block && typeof block === 'object' && !Array.isArray(block) && block.type === 'tool_use'
        && typeof block.id === 'string' && (!completedTools.has(block.id) || uncertainTools.has(block.id)))) continue;
      const result = await sideMessageText(view.entry.location, stored, Math.min(6_000, remaining - 40));
      if (!result.text) continue;
      const line = '[' + row.seq + ' ' + row.role + '] ' + result.text;
      recent.push(line);
      truncated ||= result.truncated;
      remaining -= line.length + 1;
    }
    const selected = selectedSeq == null ? undefined : view.stored.get(selectedSeq);
    const anchor = selected ? await sideMessageText(view.entry.location, materializeChapterMessage(selected), 128_000) : undefined;
    return { revision: view.revision, throughSeq: view.rows.at(-1)?.seq ?? 0, truncated,
      text: [summary, ...recent.reverse()].filter(Boolean).join('\n'), selectedText: anchor?.text };
  }

  async loadAll(
    id: SessionId | string,
  ): Promise<FsSessionWithMessages | null> {
    if (!(await this.directory.entry(id))) return null;
    const result = await this.hydrated(id);
    return {
      ...(result.unresolved_tool_outcomes ? { unresolved_tool_outcomes: result.unresolved_tool_outcomes } : {}),
      resolved_tool_outcomes: result.resolved_tool_outcomes,
      tool_outcome_state: result.tool_outcome_state,
      session: result.session,
      messages: result.messages,
      message_rows: result.rows,
    };
  }

  async count(id: SessionId | string, boundary?: number): Promise<number> {
    const value = await this.projection(id);
    const result = queryConversationProjection(value, {
      kind: 'stats',
      boundary: boundary ?? compactionBoundary(value.session.state),
    });
    return result.selection!.visibleCount;
  }

  async listAttachments(id: SessionId | string, offset = 0, limit = 50) {
    const value = await this.projection(id);
    return attachmentPage(Array.from(value.stored.values(), m => Array.isArray(m.content) && m.content.some(block =>
      block && typeof block === 'object' && 'type' in block && ['artifact_ref', 'image', 'document'].includes(String(block.type)))
      ? materializeChapterMessage(m) : m), offset, limit);
  }

  async readAttachment(id: SessionId | string, seq: number, index: number) {
    const value = await this.projection(id);
    const message = value.stored.get(seq);
    return message ? readAttachment(value.entry.location, materializeChapterMessage(message), index) : null;
  }

  async loadTail(
    id: SessionId | string,
    tail: number,
  ): Promise<FsSessionWithMessages | null> {
    if (!(await this.directory.entry(id))) return null;
    const result = await this.hydrated(id, { kind: 'tail', limit: tail, boundary: await this.boundary(id) });
    return {
      unresolved_tool_outcomes: result.unresolved_tool_outcomes,
      resolved_tool_outcomes: result.resolved_tool_outcomes,
      tool_outcome_state: result.tool_outcome_state,
      session: result.session,
      messages: result.messages,
      message_rows: result.rows,
    };
  }

  async loadBefore(
    id: SessionId | string,
    beforeSeq: number,
    limit: number,
    includeArchived = false,
  ): Promise<FsMessagePage> {
    const result = await this.hydrated(id, { kind: 'before', beforeSeq, limit,
      boundary: includeArchived ? 0 : await this.boundary(id), includeArchived });
    return {
      messages: result.messages,
      message_rows: result.rows,
      next_cursor: result.selection!.nextCursor,
    };
  }

  /**
   * Read a bounded chronological message range from the same short-lived
   * hydrated projection used by normal transcript pagination. Chapter source
   * expansion previously parsed and hydrated the entire JSONL file on every
   * page request; sharing this reader makes consecutive source pages reuse one
   * projection and keeps cursor semantics authoritative in the backend.
   */
  async loadRange(
    id: SessionId | string,
    startSeq: number,
    endSeq: number,
    afterSeq: number,
    limit: number,
  ): Promise<FsConversationChapterSourcePage> {
    const result = await this.hydrated(id, { kind: 'range', startSeq, endSeq, afterSeq, limit });
    return {
      items: result.rows,
      next_cursor: result.selection!.nextCursor === null ? null : `message:${result.selection!.nextCursor}`,
    };
  }

  async listAfter(
    id: SessionId | string,
    afterSeq: number,
  ): Promise<{ messages: AgentMessage[]; maxSeq: number }> {
    const result = await this.hydrated(id, { kind: 'after', afterSeq });
    return {
      messages: result.messages,
      maxSeq: result.rows.at(-1)?.seq ?? afterSeq,
    };
  }

  async getMessage(
    id: SessionId | string,
    seq: number,
  ): Promise<{
    role: AgentMessage['role'];
    content: unknown;
    row: FsCoderMessageRow;
  } | null> {
    const result = await this.hydrated(id, { kind: 'message', seq });
    if (result.rows.length === 0) return null;
    return {
      role: result.rows[0].role,
      content: result.messages[0].content,
      row: result.rows[0],
    };
  }

  async firstUserText(id: SessionId | string): Promise<string | null> {
    const result = await this.hydrated(id, { kind: 'firstUser' });
    const message = result.messages[0];
    return message ? extractText(message) : null;
  }

  async latestUserText(id: SessionId | string): Promise<string | null> {
    const result = await this.hydrated(id, { kind: 'latestUser' });
    const message = result.messages[0];
    return message ? extractText(message) : null;
  }

  async maxSeq(id: SessionId | string): Promise<number> {
    const entry = await this.directory.requireEntry(id);
    const conversationPath = sessionJournalPath(entry.location.bundle_path);
    assertContainedPath(entry.location.bundle_path, conversationPath);
    await assertPathHasNoLinks(
      entry.location.bundle_path,
      conversationPath,
    );
    return highestMessageSeqFromTail(conversationPath);
  }

  async previousUserSeq(
    id: SessionId | string,
    beforeSeq: number,
  ): Promise<number | null> {
    const result = queryConversationProjection(await this.projection(id), { kind: 'previousUser', beforeSeq });
    return result.rows[0]?.seq ?? null;
  }

  async summaryBoundary(id: SessionId | string): Promise<number> {
    const found = await this.directory.requireEntry(id);
    const state =
      found.state ??
      this.directory.repository.readStateSync(found.location);
    return readChapterBoundarySync(
      found.location.bundle_path,
      state,
    ).boundary_seq;
  }

  async archivedCount(id: SessionId | string): Promise<number> {
    const result = await this.hydrated(id, { kind: 'stats', boundary: await this.boundary(id) });
    return result.selection!.archivedCount;
  }

  setCompactionBoundary(
    id: SessionId | string,
    summaryText: string,
    boundarySeq: number,
    kind: 'auto' | 'manual',
  ): Promise<{ boundary_seq: number; pruned_count: number }> {
    return this.directory.runMutation(id, async () => {
      const result = await this.hydrated(id);
      const max = result.rows.at(-1)?.seq ?? 0;
      if (
        !Number.isSafeInteger(boundarySeq) ||
        boundarySeq < 0 ||
        boundarySeq > max
      ) {
        throw new TypeError(`Invalid compaction boundary ${boundarySeq}`);
      }
      const previous = compactionBoundary(result.session.state);
      const pruned = result.rows.filter(
        (row) => row.seq > previous && row.seq <= boundarySeq,
      ).length;
      await this.directory.repository.updateState(
        result.entry.location,
        (state) => ({
          ...state,
          compaction: {
            ...state.compaction,
            boundary_seq: boundarySeq,
            summary: summaryText,
            count_auto:
              finiteNumber(state.compaction.count_auto) +
              (kind === 'auto' ? 1 : 0),
            count_manual:
              finiteNumber(state.compaction.count_manual) +
              (kind === 'manual' ? 1 : 0),
          },
          extra: {
            ...state.extra,
            runtime: {
              ...(state.extra.runtime &&
              typeof state.extra.runtime === 'object' &&
              !Array.isArray(state.extra.runtime)
                ? state.extra.runtime
                : {}),
              last_response_id: null,
              last_response_message_count: null,
            },
          },
        }),
      );
      return { boundary_seq: boundarySeq, pruned_count: pruned };
    });
  }
}
