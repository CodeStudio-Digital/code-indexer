import { open, type FileHandle } from 'node:fs/promises';
import { dirname } from 'node:path';
import { ChapterArchiveReader, decodeChapterCommit } from '../chapter-transcript.js';
import type { ConversationCommit } from '../types.js';
import { parseCoderTurnPayload } from './conversation-codec.js';

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

/**
 * Streams committed conversation records newest-first without materializing
 * the JSONL. Consumers must apply domain projection semantics, including
 * rollback markers, before exposing records.
 */
export async function* reverseCommittedConversationCommits(
  conversationPath: string,
  mode: 'full' | 'metadata' = 'full',
): AsyncGenerator<ConversationCommit> {
  const archive = new ChapterArchiveReader();
  for await (const line of reverseCommittedConversationLines(conversationPath)) {
    try {
      yield decodeChapterCommit(JSON.parse(line) as ConversationCommit, dirname(conversationPath), mode, archive).commit;
    } catch (error) {
      throw new Error(
        `Invalid committed conversation JSON near tail: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
}

export async function highestMessageSeqFromTail(
  conversationPath: string,
): Promise<number> {
  for await (const commit of reverseCommittedConversationCommits(conversationPath, 'metadata')) {
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
