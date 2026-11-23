import { dirname } from 'node:path';
import { open, type FileHandle } from 'node:fs/promises';
import { ChapterArchiveReader } from '../chapter-transcript.js';
import { parseJournalRecord } from '../session-writer.js';
import { parseCoderTurnPayload } from './conversation-codec.js';

export interface MemoryCallSignal { tool_name: string; created_at: string }
interface StoredSignal extends MemoryCallSignal { messageSeq: number }
interface Cursor {
  identity: string; size: number; modified: string; offset: number; seq: number; hash: string | null;
  head: Buffer; tail: Buffer; calls: StoredSignal[];
}
export interface MemoryProjectionRead {
  calls: MemoryCallSignal[];
  bytesRead: number;
  commitsParsed: number;
  reset: boolean;
}
const CHUNK_BYTES = 64 * 1024;
const SAMPLE_BYTES = 512;

/** Incremental metadata-only projection. No message body or tool output survives a read. */
export class MemoryCallProjection {
  private readonly cursors = new Map<string, Cursor>();
  private readonly pending = new Map<string, Promise<MemoryProjectionRead>>();

  read(path: string): Promise<MemoryProjectionRead> {
    const pending = this.pending.get(path);
    if (pending) return pending;
    const next = this.readFile(path).finally(() => { this.pending.delete(path); });
    this.pending.set(path, next);
    return next;
  }

  private async readFile(path: string): Promise<MemoryProjectionRead> {
    let handle: FileHandle;
    try { handle = await open(path, 'r'); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      this.cursors.delete(path);
      return { calls: [], bytesRead: 0, commitsParsed: 0, reset: true };
    }
    let bytesRead = 0, commitsParsed = 0;
    const read = async (position: number, length: number): Promise<Buffer> => {
      if (length <= 0) return Buffer.alloc(0);
      const buffer = Buffer.allocUnsafe(length);
      const result = await handle.read(buffer, 0, length, position);
      bytesRead += result.bytesRead;
      return buffer.subarray(0, result.bytesRead);
    };
    try {
      const info = await handle.stat();
      const identity = `${info.dev}:${info.ino}:${info.birthtimeMs}`;
      const modified = `${info.mtimeMs}:${info.ctimeMs}`;
      const old = this.cursors.get(path);
      if (old && old.identity === identity && old.size === info.size && old.modified === modified) {
        return { calls: old.calls.map(({ tool_name, created_at }) => ({ tool_name, created_at })), bytesRead, commitsParsed, reset: false };
      }
      let append = Boolean(old && old.identity === identity && info.size > old.size);
      if (append && old) {
        // Detect replacement/truncation-rewrite, including filesystems reusing an inode.
        const head = await read(0, old.head.length);
        const tail = await read(Math.max(0, old.offset - old.tail.length), old.tail.length);
        append = head.equals(old.head) && tail.equals(old.tail);
      }
      const state: Cursor = append && old
        ? { ...old, calls: [...old.calls] }
        : { identity, size: 0, modified: '', offset: 0, seq: 0, hash: null, head: Buffer.alloc(0), tail: Buffer.alloc(0), calls: [] };
      let position = state.offset;
      let carry: Buffer = Buffer.alloc(0);
      const archive = new ChapterArchiveReader();
      while (position < info.size) {
        const chunk = await read(position, Math.min(CHUNK_BYTES, info.size - position));
        if (!chunk.length) break;
        const base = position - carry.length;
        position += chunk.length;
        const buffer = carry.length ? Buffer.concat([carry, chunk]) : chunk;
        let start = 0;
        for (let end = buffer.indexOf(10, start); end >= 0; end = buffer.indexOf(10, start)) {
          const commit = parseJournalRecord(buffer.toString('utf8', start, end), dirname(path),
            state.seq + 1, state.hash, 'metadata', archive);
          const payload = parseCoderTurnPayload(commit);
          if (payload.truncate_from_seq !== undefined) {
            state.calls = state.calls.filter(call => call.messageSeq < payload.truncate_from_seq!);
          }
          for (const call of payload.tool_calls) {
            if (/^(?:mcp__)?(?:recall_memory|remember|forget_memory|search_memory|save_memory)$/.test(call.tool_name)) {
              state.calls.push({ tool_name: call.tool_name, created_at: call.output.created_at, messageSeq: call.message_seq });
            }
          }
          state.seq = commit.seq; state.hash = commit.hash; state.offset = base + end + 1;
          commitsParsed += 1; start = end + 1;
        }
        // Keep only uncommitted bytes until another chunk/newline arrives.
        carry = buffer.subarray(start);
      }
      state.identity = identity; state.size = info.size; state.modified = modified;
      state.head = await read(0, Math.min(SAMPLE_BYTES, state.offset));
      state.tail = await read(Math.max(0, state.offset - SAMPLE_BYTES), Math.min(SAMPLE_BYTES, state.offset));
      this.cursors.delete(path); this.cursors.set(path, state);
      // Bound retained metadata for very large catalogs. Eviction only costs a later cold read.
      while (this.cursors.size > 2048) this.cursors.delete(this.cursors.keys().next().value!);
      return { calls: state.calls.map(({ tool_name, created_at }) => ({ tool_name, created_at })), bytesRead, commitsParsed, reset: !append };
    } catch (error) {
      this.cursors.delete(path);
      throw error;
    } finally { await handle.close(); }
  }
}
