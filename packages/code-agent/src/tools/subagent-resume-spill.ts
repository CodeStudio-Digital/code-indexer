import { maxSessionBytes, ttlMs, leaseMs, spillTerminalTranscripts, sweepIntervalMs, retainCompletedTranscripts, configureResumeSettings } from './subagent-resume-settings.js';
import type { ResumableAgentState, ResumableGroup, ResumeRegistryConfiguration, ResumeCheckpointStore } from './subagent-resume-types.js';
import { removeSessionSpill, removeSpillFile, spillTranscriptToDisk } from '@mcp/code-agent/tools/subagent-transcript-spill.js';
import type { SessionId } from '@mcp/session-storage';
/**
 * Spill a COMPLETED agent's (already sanitized) transcript to disk and drop it
 * from RAM, leaving a pointer + metadata. Only completed agents are spilled —
 * failed/aborted keep their in-RAM transcript so resume_agent can relaunch
 * them. A spill failure is non-fatal: the transcript simply stays in RAM.
 */
export async function maybeSpillAgent(
  store: ResumeCheckpointStore | undefined,
  sessionId: SessionId,
  spawnId: string,
  agent: ResumableAgentState,
): Promise<void> {
  if (agent.spillPath) { removeSpillFile(agent.spillPath); agent.spillPath = undefined; }
  if (!spillTerminalTranscripts()) return;
  if (agent.reason !== 'completed') return;
  if (!agent.transcript || agent.transcript.length === 0) return;
  const path = await spillTranscriptToDisk(
    store,
    sessionId,
    spawnId,
    agent.agentIndex,
    agent.transcript,
  );
  if (path) {
    agent.spillPath = path;
    agent.transcript = undefined;
  }
}
