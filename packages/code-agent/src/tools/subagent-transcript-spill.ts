/**
 * subagent-transcript-spill — off-heap storage for TERMINAL (completed,
 * non-resumable) subagent transcripts.
 *
 * The resume registry keeps FAILED/ABORTED transcripts in RAM so `resume_agent`
 * can relaunch from where they stopped, but a COMPLETED agent's transcript is
 * only needed for observability (`read_agent_transcript`). Spilling it to a
 * per-session JSONL file frees the tens of MB of worker RAM that all-completed
 * spawn groups otherwise pin for the full 45-min retention window, while the
 * transcript stays readable on demand.
 *
 * Layout mirrors apps/http-api/sse/runtime-event-log-storage.ts:
 * `<base>/<sessionId>/<spawnId>.<agentIndex>.jsonl`, one AgentMessage per line.
 * `MCP_SUBAGENT_TRANSCRIPT_DIR` overrides the base; the default lives under the
 * canonical MCP data dir. The spill is a best-effort optimization: every write
 * can fail without loss because the caller only drops the in-RAM copy once the
 * file exists.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { AgentMessage } from '@mcp/code-agent/core/messages.js';
import { subagentTranscriptsBaseDir } from '@mcp/shared/utils/data-paths.js';

/** Read the base dir lazily so ops (and tests) can point it elsewhere via env. */
function baseDir(): string {
  const override = process.env.MCP_SUBAGENT_TRANSCRIPT_DIR?.trim();
  return override ? resolve(override) : subagentTranscriptsBaseDir();
}

function sessionDir(sessionId: number): string {
  return join(baseDir(), String(sessionId));
}

/** spawnId is an 8-hex/group token and agentIndex a small int — sanitized anyway. */
function agentFile(sessionId: number, spawnId: string, agentIndex: number): string {
  const safeSpawn = spawnId.replace(/[^A-Za-z0-9_-]/g, '_');
  return join(sessionDir(sessionId), `${safeSpawn}.${agentIndex}.jsonl`);
}

/**
 * Write one terminal transcript to disk as JSONL. Returns the file path on
 * success, or `null` if the write failed — the caller then keeps the transcript
 * in RAM, so a spill failure degrades to the old (all-in-RAM) behavior rather
 * than losing observability.
 */
export function spillTranscriptToDisk(
  sessionId: number,
  spawnId: string,
  agentIndex: number,
  transcript: AgentMessage[],
): string | null {
  if (transcript.length === 0) return null;
  try {
    mkdirSync(sessionDir(sessionId), { recursive: true });
    const file = agentFile(sessionId, spawnId, agentIndex);
    writeFileSync(file, transcript.map((m) => JSON.stringify(m)).join('\n'), 'utf8');
    return file;
  } catch {
    return null;
  }
}

/** Read a spilled transcript back. Returns `null` when missing or unreadable. */
export function readSpilledTranscript(spillPath: string): AgentMessage[] | null {
  try {
    if (!existsSync(spillPath)) return null;
    const out: AgentMessage[] = [];
    for (const line of readFileSync(spillPath, 'utf8').split(/\r?\n/)) {
      if (!line) continue;
      try { out.push(JSON.parse(line) as AgentMessage); }
      catch { /* skip a partial/corrupt row rather than fail the whole read */ }
    }
    return out.length > 0 ? out : null;
  } catch {
    return null;
  }
}

/** Remove a single spill file (best-effort) — used when a group is evicted. */
export function removeSpillFile(spillPath: string): void {
  try { rmSync(spillPath, { force: true }); } catch { /* already gone */ }
}

/** Remove every spill for a session — used on clearSession. */
export function removeSessionSpill(sessionId: number): void {
  try { rmSync(sessionDir(sessionId), { recursive: true, force: true }); }
  catch { /* already gone */ }
}
