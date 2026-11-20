/**
 * subagent-transcript-spill — off-heap storage for TERMINAL (completed,
 * non-resumable) subagent transcripts.
 *
 * The resume registry keeps FAILED/ABORTED transcripts in RAM (they were kept
 * for the retired `resume_agent`), but a COMPLETED agent's transcript is
 * only needed for observability (the dashboard Transcript tab). Spilling it to a
 * per-session entity frees the tens of MB of worker RAM that all-completed
 * spawn groups otherwise pin for the full 45-min retention window, while the
 * transcript stays readable on demand.
 *
 * Transcripts are entities inside the owning session bundle's `subagents/`
 * directory. The spill is a best-effort optimization: every write can fail
 * without loss because the caller only drops the in-RAM copy once the file
 * exists.
 */
import { open } from 'node:fs/promises';
import type { AgentMessage } from '@mcp/code-agent/core/messages.js';
import type { SessionId } from '@mcp/session-storage';

export interface SubagentTranscriptStore {
  writeSubagentTranscript(
    sessionId: SessionId,
    spawnId: string,
    agentIndex: number,
    transcript: AgentMessage[],
  ): Promise<string | null>;
  findSubagentTranscript?(
    sessionId: SessionId,
    spawnId: string,
    agentIndex: number,
  ): Promise<string | null>;
}

/**
 * Write one terminal transcript to the owning bundle. Returns its entity path
 * on success, or `null` when no file-backed session store is available.
 */
export async function spillTranscriptToDisk(
  store: SubagentTranscriptStore | undefined,
  sessionId: SessionId,
  spawnId: string,
  agentIndex: number,
  transcript: AgentMessage[],
): Promise<string | null> {
  if (!store || transcript.length === 0) return null;
  try {
    return await store.writeSubagentTranscript(
      sessionId,
      spawnId,
      agentIndex,
      transcript,
    );
  } catch {
    return null;
  }
}

/** Production readers yield during file IO and cap allocation before parsing.
 * Retained transcripts are observational; an unavailable/oversized entity
 * falls back to the already retained final report. */
export async function readSpilledTranscriptAsync(spillPath: string, signal?: AbortSignal): Promise<AgentMessage[] | null> {
  signal?.throwIfAborted();
  try {
    const handle = await open(spillPath, 'r');
    try {
      const before = await handle.stat();
      if (!before.isFile() || before.size > 64 * 1024 * 1024) return null;
      const bytes = Buffer.alloc(before.size + 1);
      let offset = 0;
      while (offset < bytes.length) {
        signal?.throwIfAborted();
        const { bytesRead } = await handle.read(bytes, offset, Math.min(128 * 1024, bytes.length - offset), offset);
        if (!bytesRead) break;
        offset += bytesRead;
      }
      signal?.throwIfAborted();
      const after = await handle.stat();
      if (offset !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs) return null;
      const envelope = JSON.parse(bytes.subarray(0, offset).toString('utf8')) as {
        kind?: string; data?: { messages?: AgentMessage[] };
      };
      return envelope.kind === 'subagent_transcript' && Array.isArray(envelope.data?.messages)
        ? envelope.data.messages : null;
    } finally { await handle.close(); }
  } catch (cause) {
    signal?.throwIfAborted();
    return null;
  }
}

/**
 * Session artifacts do not expire independently. Registry eviction only
 * releases the in-memory pointer; the bundle is removed with the session.
 */
export function removeSpillFile(_spillPath: string): void {
  // Intentionally retained until session deletion.
}

