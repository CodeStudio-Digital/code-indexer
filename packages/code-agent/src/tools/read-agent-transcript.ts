/**
 * The dashboard's Transcript tab (coder-worker RPC readAgentTranscript):
 * renders the RETAINED transcript of a finished workflow agent, or of an
 * older session's spawn_agent agent, as a bounded digest: what it was asked,
 * which tools it called with which inputs, result sizes/excerpts, and its
 * final text. Backed by the resume registry; nothing here re-enters the
 * child's context or re-runs anything. (The read_agent_transcript tool that
 * shared this renderer is retired.)
 */
import type { AgentMessage } from '@mcp/code-agent/core/messages.js';
import {
  getReadableGroup,
  type ResumeCheckpointStore,
  type ResumableAgentState,
} from '@mcp/code-agent/tools/subagent-resume-registry.js';
import { readSpilledTranscriptAsync } from '@mcp/code-agent/tools/subagent-transcript-spill.js';
import { renderTranscriptDigestAsync } from './subagent-transcript-digest.js';
import type { SessionId } from '@mcp/session-storage';

/** Tool/UI path: asynchronous spill reads and cooperative digest rendering. */
export async function renderAgentTranscriptAsync(agent: ResumableAgentState,
  opts: { maxChars?: number; signal?: AbortSignal } = {}): Promise<string> {
  opts.signal?.throwIfAborted();
  const messages = agent.transcript?.length ? agent.transcript
    : agent.spillPath ? await readSpilledTranscriptAsync(agent.spillPath, opts.signal) ?? [] : [];
  return renderTranscriptDigestAsync(agent, messages, opts.maxChars, opts.signal);
}
function resolveRetainedAgent(
  agents: ResumableAgentState[],
  agentRef: string | number | undefined,
): ResumableAgentState | undefined {
  if (typeof agentRef === 'number' && Number.isFinite(agentRef)) {
    const requestedIndex = Math.floor(agentRef);
    // UI/runtime agent arrays are zero-based while this public tool is
    // historically one-based. Zero is outside the public range, so accepting
    // it as a first-agent alias is unambiguous and prevents a needless failed
    // read when a caller forwards an internal index.
    const internalIndex = requestedIndex === 0 ? 0 : requestedIndex - 1;
    return agents.find((a) => a.agentIndex === internalIndex);
  }
  if (typeof agentRef === 'string' && agentRef.trim()) {
    const trimmed = agentRef.trim();
    const byLabel = agents.find((a) => a.label === trimmed);
    if (byLabel) return byLabel;
    const asIndex = Number.parseInt(trimmed, 10);
    if (Number.isFinite(asIndex)) {
      const internalIndex = asIndex === 0 ? 0 : asIndex - 1;
      return agents.find((a) => a.agentIndex === internalIndex);
    }
    return undefined;
  }
  return agents.length === 1 ? agents[0] : undefined;
}

/** Route-facing helper: locate one retained agent (label or 1-based index). */
export async function findRetainedAgent(
  sessionId: SessionId,
  spawnId: string,
  agentRef: string | number | undefined,
  store?: ResumeCheckpointStore,
): Promise<ResumableAgentState | undefined> {
  const group = await getReadableGroup(sessionId, spawnId, store);
  if (!group) return undefined;
  return resolveRetainedAgent(group.agents, agentRef);
}

/** AgentMessage kept import-referenced for route typing convenience. */
export type { AgentMessage };
