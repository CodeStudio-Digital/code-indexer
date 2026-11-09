import type { AgentMessage, ChatUsage } from '@mcp/code-agent/core/messages.js';
import type { StopReason } from '@mcp/code-agent/core/runner.js';
import type { SubagentLimits } from '@mcp/code-agent/tools/implement-subagent.js';
import type { MicroAgentProfileId } from '@mcp/code-agent/tools/micro-agent-profiles.js';
import type { SubagentResearchPolicy } from '@mcp/code-agent/tools/subagent-research-policy.js';
import type { SessionId } from '@mcp/session-storage';
export interface ResumableAgentState {
  execution?: import('@mcp/agent-runtime-contracts').ExecutionSnapshot;
  workResult?: import('@mcp/agent-runtime-contracts').AgentWorkResult;
  /** 0-based; matches agent_progress.agentIndex and the original roster. */
  agentIndex: number;
  label: string;
  task: string;
  /** Allowlist + systemPrompt are re-resolved from this at resume time. */
  profileId: MicroAgentProfileId;
  files?: string[];
  /** Original soft research contract, preserved across resumptions. */
  researchPolicy?: SubagentResearchPolicy;
  maxTurns: number;
  limits: SubagentLimits;
  /**
   * Pairing-repaired; retained in RAM for RESUMABLE (non-completed) agents.
   * For a COMPLETED agent it is spilled to disk (see `spillPath`) and dropped
   * from RAM, so a big all-completed group no longer pins tens of MB.
   */
  transcript?: AgentMessage[];
  /**
   * Set when this agent's transcript was spilled to a bundle entity instead of
   * kept in `transcript`. read_agent_transcript falls back to it. Only
   * completed (never-resumed) agents are spilled, so resume state is unaffected.
   */
  spillPath?: string;
  reason: StopReason;
  effectOutcome?: 'unknown';
  /** Watchdog message / error text — feeds the continuation nudge. */
  failureNote?: string;
  /** Final report text (capped) — read_agent_transcript's fallback/summary. */
  finalText?: string;
  toolCallCount: number;
  usage: ChatUsage;
  /** 1 = original run; bumped on each resume. */
  attempt: number;
  capturedAt: number;
  approxBytes: number;
}


export interface ResumableGroup {
  /** == groupId for parallel spawns; fresh 8-hex for single spawns. */
  spawnId: string;
  sessionId: SessionId;
  provider: string;
  model: string;
  createdAt: number;
  /** Wall-clock of the last retain/access — drives TTL expiry. */
  lastTouchedAt: number;
  /** Monotonic touch sequence — drives deterministic LRU eviction. */
  seq?: number;
  /** FULL roster — completed agents keep metadata but carry no transcript. */
  agents: ResumableAgentState[];
}


export interface ResumeRegistryConfiguration {
  maxAgentBytes: number;
  maxSessionBytes: number;
  ttlMs: number;
  leaseMs: number;
  spillTerminalTranscripts: boolean;
  retainCompletedTranscripts: boolean;
  sweepIntervalMs: number;
}


export interface ResumeCheckpointStore {
  saveOrchestrationCheckpoint(input: {
    sessionId: SessionId;
    kind: 'subagent_resume';
    scopeId: string;
    privacyClass: 'session_private_redacted';
    payloadJson: string;
    expiresAt: string;
    leaseToken?: string;
  }): Promise<boolean>;
  loadOrchestrationCheckpoint(
    sessionId: SessionId,
    kind: 'subagent_resume',
    scopeId: string,
  ): Promise<{ payload_json: string } | null>;
  listOrchestrationCheckpoints(
    sessionId: SessionId,
    kind: 'subagent_resume',
    limit?: number,
  ): Promise<Array<{ scope_id: string; payload_json: string }>>;
  loadOrchestrationCheckpointForAudit?(
    sessionId: SessionId, kind: 'subagent_resume', scopeId: string,
  ): Promise<{ payload_json: string } | null>;
  listOrchestrationCheckpointsForAudit?(
    sessionId: SessionId, kind: 'subagent_resume', limit?: number,
  ): Promise<Array<{ scope_id: string; payload_json: string }>>;
  removeOrchestrationCheckpoint(
    sessionId: SessionId,
    kind: 'subagent_resume',
    scopeId: string,
    leaseToken?: string,
  ): Promise<void>;
  tryAcquireOrchestrationCheckpoint(
    sessionId: SessionId,
    kind: 'subagent_resume',
    scopeId: string,
    leaseMs?: number,
  ): Promise<string | null>;
  releaseOrchestrationCheckpoint(
    sessionId: SessionId,
    kind: 'subagent_resume',
    scopeId: string,
    leaseToken: string,
  ): Promise<void>;
  renewOrchestrationCheckpoint(
    sessionId: SessionId,
    kind: 'subagent_resume',
    scopeId: string,
    leaseToken: string,
    leaseMs?: number,
  ): Promise<boolean>;
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
