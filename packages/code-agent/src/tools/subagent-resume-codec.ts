import { maxAgentBytes } from './subagent-resume-settings.js';
import type { ResumableGroup, ResumeCheckpointStore } from './subagent-resume-types.js';
import type { AgentMessage } from '@mcp/code-agent/core/messages.js';
import type { StopReason } from '@mcp/code-agent/core/runner.js';
import { repairToolPairing } from '@mcp/code-agent/core/transcript-repair.js';
import { sanitizeCheckpointValue, sanitizeMessagesForCheckpoint } from '@mcp/code-agent/tools/orchestration-checkpoint-redaction.js';
import type { SessionId } from '@mcp/session-storage';
/** Keep the tail of a transcript verbatim when byte-capping (prefix elision). */
export const PROTECTED_TAIL_MESSAGES = 20;

export const ELIDE_RESULT_OVER_BYTES = 2048;

export const ELIDED_MARKER = '[elided at resume-capture — re-read if needed]';

export async function hydrateSpillPaths(
  group: ResumableGroup,
  store?: ResumeCheckpointStore,
): Promise<void> {
  if (typeof store?.findSubagentTranscript !== 'function') return;
  await Promise.all(group.agents.map(async (agent) => {
    if (agent.transcript || agent.spillPath) return;
    agent.spillPath = (
      await store.findSubagentTranscript!(
        group.sessionId,
        group.spawnId,
        agent.agentIndex,
      )
    ) ?? undefined;
  }));
}

export function approxBytesOf(value: unknown): number {
  try { return JSON.stringify(value)?.length ?? 0; } catch { return 0; }
}

export function durableProjection(group: ResumableGroup): ResumableGroup {
  const projected = {
    ...group,
    agents: group.agents.map((agent) => ({
      ...agent,
      // Completed transcripts are useful in the current process but are not
      // needed to resume and therefore never enter the durable checkpoint.
      transcript: agent.reason === 'completed' || !agent.transcript
        ? undefined
        : sanitizeMessagesForCheckpoint(agent.transcript),
      // The spill pointer is a host-local filesystem path — never persist it
      // into the cross-executor checkpoint (another host has no such file).
      spillPath: undefined,
    })),
  };
  return sanitizeCheckpointValue(projected);
}

export function parsePersistedGroup(
  payloadJson: string,
  sessionId: SessionId,
  spawnId: string,
): ResumableGroup | undefined {
  try {
    const group = JSON.parse(payloadJson) as ResumableGroup;
    if (!group || group.sessionId !== sessionId || group.spawnId !== spawnId
      || !Array.isArray(group.agents)
      || !group.agents.every((agent) =>
        agent && typeof agent.agentIndex === 'number'
        && typeof agent.label === 'string'
        && typeof agent.task === 'string'
        && typeof agent.reason === 'string'
        && typeof agent.attempt === 'number')) {
      return undefined;
    }
    for (const agent of group.agents) {
      if (agent.effectOutcome !== undefined && agent.effectOutcome !== 'unknown') return undefined;
      if (agent.transcript) {
        agent.transcript = sanitizeTranscriptForResume(agent.transcript, agent.reason);
        agent.approxBytes = approxBytesOf(agent.transcript);
      }
    }
    return group;
  } catch {
    return undefined;
  }
}

/**
 * Deterministic byte-cap: replace large tool_result contents with a marker
 * until under `MAX_AGENT_BYTES`. Prefers to keep the last
 * `PROTECTED_TAIL_MESSAGES` (recent context, prefix-stable) — a FIRST pass
 * elides only from the front. But the cap is a HARD guarantee: if the front
 * pass can't get under it (a giant single tool_result, or a transcript ≤
 * PROTECTED_TAIL messages where `editable===0`), a SECOND pass elides the tail
 * too, back-to-front, so an oversized short transcript can't blow the provider
 * context window when re-sent as the resume seed.
 */
export function capTranscriptBytes(transcript: AgentMessage[]): AgentMessage[] {
  const cap = maxAgentBytes();
  let total = approxBytesOf(transcript);
  if (total <= cap) return transcript;
  const out = transcript.map((m) => ({ ...m, content: [...m.content] }));

  const elideMsg = (m: AgentMessage): void => {
    if (m.role !== 'tool') return;
    m.content = m.content.map((b) => {
      if (total <= cap) return b;
      if (b.type !== 'tool_result' || typeof b.content !== 'string') return b;
      if (b.content.length <= ELIDE_RESULT_OVER_BYTES) return b;
      total -= b.content.length - ELIDED_MARKER.length;
      return { ...b, content: ELIDED_MARKER };
    });
  };

  // Pass 1 — front (protect the tail).
  const editable = Math.max(0, out.length - PROTECTED_TAIL_MESSAGES);
  for (let i = 0; i < editable && total > cap; i++) elideMsg(out[i]);
  // Pass 2 — still over: elide the protected tail too, newest last.
  for (let i = out.length - 1; i >= editable && total > cap; i--) elideMsg(out[i]);
  return out;
}

export function sanitizeTranscriptForResume(
  transcript: AgentMessage[],
  reason: StopReason,
): AgentMessage[] {
  // Pop trailing messages with empty content (stream died mid-assembly).
  let end = transcript.length;
  while (end > 0 && transcript[end - 1].content.length === 0) end--;
  const repaired = repairToolPairing(
    transcript.slice(0, end),
    (name) =>
      `[Interrupted — the subagent was stopped (${reason}) while "${name}" was running. ` +
      `Result not captured. Re-issue this call if it still matters.]`,
  );
  return capTranscriptBytes(repaired);
}
