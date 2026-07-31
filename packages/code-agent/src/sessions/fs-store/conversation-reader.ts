import { open, type FileHandle } from 'node:fs/promises';
import { join } from 'node:path';
import type { AgentMessage } from '@mcp/code-agent/core/messages.js';
import {
  assertContainedPath,
  assertPathHasNoLinks,
  type ConversationCommit,
  type SessionId,
} from '@mcp/session-storage';
import {
  extractText,
  hydrateMessage,
  messageRow,
  parseCoderTurnPayload,
  projectConversation,
} from './conversation-codec.js';
import { readChapterBoundarySync } from './conversation-chapter-codec.js';
import { compactionBoundary, finiteNumber } from './session-projection.js';
import { FsSessionDirectory } from './session-directory.js';
import type {
  FsCoderMessageRow,
  FsMessagePage,
  FsSessionWithMessages,
} from './types.js';

interface HydratedConversation {
  entry: Awaited<ReturnType<FsSessionDirectory['requireEntry']>>;
  session: ReturnType<FsSessionDirectory['map']>;
  rows: FsCoderMessageRow[];
  messages: AgentMessage[];
  projection: ReturnType<typeof projectConversation>;
}

const CONVERSATION_TAIL_CHUNK_BYTES = 64 * 1024;

/**
 * Iterate only newline-committed JSONL records, newest first. A writer may
 * leave an uncommitted partial suffix after a crash; like the authoritative
 * full reader, this deliberately ignores bytes after the last newline.
 *
 * The previous max-sequence path synchronously read, validated, projected and
 * hydrated the entire conversation. The five-minute memory sweep called it for
 * every old session, producing multi-second main-process stalls and retaining
 * large temporary heaps. Message sequence numbers are append-only, so the
 * newest commit that contains a message is sufficient.
 */
async function* reverseCommittedConversationLines(
  conversationPath: string,
): AsyncGenerator<string> {
  let handle: FileHandle;
  try {
    handle = await open(conversationPath, 'r');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }

  try {
    const stats = await handle.stat();
    let position = stats.size;
    let carry = Buffer.alloc(0);
    let foundCommittedSuffix = false;

    while (position > 0) {
      const length = Math.min(CONVERSATION_TAIL_CHUNK_BYTES, position);
      position -= length;
      const chunk = Buffer.allocUnsafe(length);
      const { bytesRead } = await handle.read(chunk, 0, length, position);
      const combined = Buffer.concat([chunk.subarray(0, bytesRead), carry]);
      let lineEnd = combined.length;

      if (!foundCommittedSuffix) {
        const finalNewline = combined.lastIndexOf(0x0a);
        if (finalNewline < 0) {
          carry = combined;
          continue;
        }
        foundCommittedSuffix = true;
        lineEnd = finalNewline;
      }

      for (let index = lineEnd - 1; index >= 0; index -= 1) {
        if (combined[index] !== 0x0a) continue;
        const line = combined.subarray(index + 1, lineEnd);
        if (line.byteLength === 0) {
          throw new Error('Blank committed conversation line');
        }
        yield line.toString('utf8');
        lineEnd = index;
      }
      carry = Buffer.from(combined.subarray(0, lineEnd));
    }

    if (foundCommittedSuffix && carry.byteLength > 0) {
      yield carry.toString('utf8');
    }
  } finally {
    await handle.close();
  }
}

async function highestMessageSeqFromTail(
  conversationPath: string,
): Promise<number> {
  for await (const line of reverseCommittedConversationLines(conversationPath)) {
    let commit: ConversationCommit;
    try {
      commit = JSON.parse(line) as ConversationCommit;
    } catch (error) {
      throw new Error(
        `Invalid committed conversation JSON near tail: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    const payload = parseCoderTurnPayload(commit);
    if (payload.messages.length === 0) continue;
    let highest = 0;
    for (const message of payload.messages) {
      if (!Number.isSafeInteger(message.seq) || message.seq < 1) {
        throw new Error(
          `Conversation seq ${commit.seq} has an invalid message sequence`,
        );
      }
      highest = Math.max(highest, message.seq);
    }
    return highest;
  }
  return 0;
}

export class FsConversationReader {
  constructor(private readonly directory: FsSessionDirectory) {}

  private async hydrated(id: SessionId | string): Promise<HydratedConversation> {
    const entry = await this.directory.requireEntry(id);
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
      await this.directory.repository.readConversation(entry.location),
    );
    const messages = projection.storedMessages.map((stored) =>
      hydrateMessage(entry.location, stored),
    );
    const rows = projection.storedMessages.map((stored, index) =>
      messageRow(entry.session.id, stored, messages[index]),
    );
    return {
      entry,
      session,
      rows,
      messages,
      projection,
    };
  }

  async loadSession(
    id: SessionId | string,
  ): Promise<FsSessionWithMessages | null> {
    if (!(await this.directory.entry(id))) return null;
    const result = await this.hydrated(id);
    const boundary = compactionBoundary(result.session.state);
    const visible = result.rows
      .map((row, index) => ({ row, message: result.messages[index] }))
      .filter(({ row }) => row.seq > boundary);
    return {
      session: result.session,
      messages: visible.map((item) => item.message),
      message_rows: visible.map((item) => item.row),
    };
  }

  async loadAll(
    id: SessionId | string,
  ): Promise<FsSessionWithMessages | null> {
    if (!(await this.directory.entry(id))) return null;
    const result = await this.hydrated(id);
    return {
      session: result.session,
      messages: result.messages,
      message_rows: result.rows,
    };
  }

  async count(id: SessionId | string): Promise<number> {
    const result = await this.hydrated(id);
    const boundary = compactionBoundary(result.session.state);
    return result.rows.filter((row) => row.seq > boundary).length;
  }

  async loadTail(
    id: SessionId | string,
    tail: number,
  ): Promise<FsSessionWithMessages | null> {
    if (!(await this.directory.entry(id))) return null;
    const result = await this.hydrated(id);
    const boundary = compactionBoundary(result.session.state);
    const visible = result.rows
      .map((row, index) => ({ row, message: result.messages[index] }))
      .filter(({ row }) => row.seq > boundary);
    const renderable = visible.filter(({ row }) => row.role !== 'tool');
    const cutoff =
      renderable[Math.max(0, renderable.length - Math.max(1, tail))]?.row.seq ??
      0;
    const selected = visible
      .filter(({ row }) => row.seq >= cutoff)
      .slice(0, Math.max(1, tail) * 5);
    return {
      session: result.session,
      messages: selected.map((item) => item.message),
      message_rows: selected.map((item) => item.row),
    };
  }

  async loadBefore(
    id: SessionId | string,
    beforeSeq: number,
    limit: number,
    includeArchived = false,
  ): Promise<FsMessagePage> {
    const result = await this.hydrated(id);
    const boundary = includeArchived
      ? 0
      : compactionBoundary(result.session.state);
    const candidates = result.rows
      .map((row, index) => ({ row, message: result.messages[index] }))
      .filter(({ row }) => row.seq < beforeSeq && row.seq > boundary);
    const renderable = candidates.filter(({ row }) => row.role !== 'tool');
    const cutoff =
      renderable[Math.max(0, renderable.length - Math.max(1, limit))]?.row.seq ??
      0;
    const selected = candidates.filter(({ row }) => row.seq >= cutoff);
    return {
      messages: selected.map((item) => item.message),
      message_rows: selected.map((item) => item.row),
      next_cursor:
        selected.length > 0 && candidates[0]?.row.seq < selected[0].row.seq
          ? selected[0].row.seq
          : null,
    };
  }

  async listAfter(
    id: SessionId | string,
    afterSeq: number,
  ): Promise<{ messages: AgentMessage[]; maxSeq: number }> {
    const result = await this.hydrated(id);
    const selected = result.rows
      .map((row, index) => ({ row, message: result.messages[index] }))
      .filter(({ row }) => row.seq > afterSeq);
    return {
      messages: selected.map((item) => item.message),
      maxSeq: selected.at(-1)?.row.seq ?? afterSeq,
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
    const result = await this.hydrated(id);
    const index = result.rows.findIndex((row) => row.seq === seq);
    if (index < 0) return null;
    return {
      role: result.rows[index].role,
      content: result.messages[index].content,
      row: result.rows[index],
    };
  }

  async firstUserText(id: SessionId | string): Promise<string | null> {
    const result = await this.hydrated(id);
    const message = result.messages.find((candidate) => candidate.role === 'user');
    return message ? extractText(message) : null;
  }

  async latestUserText(id: SessionId | string): Promise<string | null> {
    const result = await this.hydrated(id);
    const message = [...result.messages]
      .reverse()
      .find(
        (candidate) =>
          candidate.role === 'user' && candidate.isMeta !== true,
      );
    return message ? extractText(message) : null;
  }

  async maxSeq(id: SessionId | string): Promise<number> {
    const entry = await this.directory.requireEntry(id);
    const conversationPath = join(
      entry.location.bundle_path,
      'conversation.jsonl',
    );
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
    const result = await this.hydrated(id);
    return (
      [...result.rows]
        .reverse()
        .find(
          (row) =>
            row.seq < beforeSeq &&
            row.role === 'user' &&
            row.is_meta === 0,
        )?.seq ?? null
    );
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
    const result = await this.hydrated(id);
    const boundary = compactionBoundary(result.session.state);
    return result.rows.filter((row) => row.seq <= boundary).length;
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
