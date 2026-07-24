/**
 * subagent-resume-registry — session-keyed retention of failed
 * ephemeral subagents so `resume_agent` can relaunch them FROM WHERE THEY
 * STOPPED (transcript preserved) instead of re-spawning from zero.
 *
 * The hot path remains in-memory, with a bounded/redacted private checkpoint
 * for explicit resume after executor recreation. The checkpoint is not a
 * claim that the old execution continued: it only preserves transcript +
 * identity so a new fenced attempt can be launched.
 *
 * Transcripts are sanitized (repairToolPairing) at RETAIN time so stored
 * state is always provider-safe and byte-capped from the FRONT (never the
 * last messages) so the resumed request shares its prefix with the failed
 * run's last request — provider prompt caching absorbs most of the replay.
 */
import type { AgentMessage, ChatUsage } from '@mcp/code-agent/core/messages.js';
import type { StopReason } from '@mcp/code-agent/core/runner.js';
import { repairToolPairing } from '@mcp/code-agent/core/transcript-repair.js';
import type { SubagentLimits } from '@mcp/code-agent/tools/implement-subagent.js';
import type { MicroAgentProfileId } from '@mcp/code-agent/tools/micro-agent-profiles.js';
import type { SubagentResearchPolicy } from '@mcp/code-agent/tools/subagent-research-policy.js';
import {
  sanitizeCheckpointValue,
  sanitizeMessagesForCheckpoint,
} from '@mcp/code-agent/tools/orchestration-checkpoint-redaction.js';
import {
  createOrchestrationLeaseGuard,
  type OrchestrationLeaseGuard,
} from '@mcp/code-agent/tools/orchestration-lease-guard.js';

export interface ResumableAgentState {
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
  /** Pairing-repaired; retained for completed agents too (observability). */
  transcript?: AgentMessage[];
  reason: StopReason;
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
  sessionId: number;
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

const MAX_GROUPS_PER_SESSION = 8;
/** Keep the tail of a transcript verbatim when byte-capping (prefix elision). */
const PROTECTED_TAIL_MESSAGES = 20;
const ELIDE_RESULT_OVER_BYTES = 2048;
const ELIDED_MARKER = '[elided at resume-capture — re-read if needed]';

// Caps read lazily so ops can tune them via env before the first spawn (a
// module-const would freeze the value at import).
function maxAgentBytes(): number {
  return Number(process.env.CODER_RESUME_MAX_AGENT_BYTES ?? 4 * 1024 * 1024) || 4 * 1024 * 1024;
}
function maxSessionBytes(): number {
  return Number(process.env.CODER_RESUME_MAX_SESSION_BYTES ?? 48 * 1024 * 1024) || 48 * 1024 * 1024;
}
function ttlMs(): number {
  return Number(process.env.CODER_RESUME_TTL_MS ?? 45 * 60_000) || 45 * 60_000;
}
function leaseMs(): number {
  const configured = Number(process.env.CODER_ORCHESTRATION_LEASE_MS ?? 120_000);
  return Number.isFinite(configured) && configured >= 60_000
    ? Math.floor(configured)
    : 120_000;
}

const bySession = new Map<number, Map<string, ResumableGroup>>();
const inFlightResumes = new Set<string>();
const resumeLeaseTokens = new Map<string, string>();
const resumeLeaseGuards = new Map<string, OrchestrationLeaseGuard>();
let touchSeq = 0;
const checkpointEnforced = (): boolean => process.env.CODER_AGENT_RUN_STORE_ENFORCE === '1';

export interface ResumeCheckpointStore {
  saveOrchestrationCheckpoint(input: {
    sessionId: number;
    kind: 'subagent_resume';
    scopeId: string;
    privacyClass: 'session_private_redacted';
    payloadJson: string;
    expiresAt: string;
    leaseToken?: string;
  }): boolean;
  loadOrchestrationCheckpoint(
    sessionId: number,
    kind: 'subagent_resume',
    scopeId: string,
  ): { payloadJson: string } | null;
  listOrchestrationCheckpoints(
    sessionId: number,
    kind: 'subagent_resume',
    limit?: number,
  ): Array<{ scopeId: string; payloadJson: string }>;
  removeOrchestrationCheckpoint(
    sessionId: number,
    kind: 'subagent_resume',
    scopeId: string,
    leaseToken?: string,
  ): void;
  tryAcquireOrchestrationCheckpoint(
    sessionId: number,
    kind: 'subagent_resume',
    scopeId: string,
    leaseMs?: number,
  ): string | null;
  releaseOrchestrationCheckpoint(
    sessionId: number,
    kind: 'subagent_resume',
    scopeId: string,
    leaseToken: string,
  ): void;
  renewOrchestrationCheckpoint(
    sessionId: number,
    kind: 'subagent_resume',
    scopeId: string,
    leaseToken: string,
    leaseMs?: number,
  ): boolean;
}

/** Stamp freshness — wall-clock for TTL, monotonic seq for deterministic LRU. */
function touch(group: ResumableGroup): void {
  group.lastTouchedAt = Date.now();
  group.seq = ++touchSeq;
}

function approxBytesOf(value: unknown): number {
  try { return JSON.stringify(value)?.length ?? 0; } catch { return 0; }
}

function durableProjection(group: ResumableGroup): ResumableGroup {
  const projected = {
    ...group,
    agents: group.agents.map((agent) => ({
      ...agent,
      // Completed transcripts are useful in the current process but are not
      // needed to resume and therefore never enter the durable checkpoint.
      transcript: agent.reason === 'completed' || !agent.transcript
        ? undefined
        : sanitizeMessagesForCheckpoint(agent.transcript),
    })),
  };
  return sanitizeCheckpointValue(projected);
}

function parsePersistedGroup(
  payloadJson: string,
  sessionId: number,
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

function persistGroup(store: ResumeCheckpointStore | undefined, group: ResumableGroup): boolean {
  if (!store || typeof store.saveOrchestrationCheckpoint !== 'function') return true;
  const key = `${group.sessionId}:${group.spawnId}`;
  const leaseToken = resumeLeaseTokens.get(key);
  if (leaseToken?.startsWith('compat:')) return !checkpointEnforced();
  const projection = durableProjection(group);
  // Keep a transcript-free completed roster as a short-lived tombstone. It
  // prevents a stale executor that loaded before the winning commit from
  // relaunching an already-completed child after it later wins the lease.
  try {
    const saved = store.saveOrchestrationCheckpoint({
      sessionId: group.sessionId,
      kind: 'subagent_resume',
      scopeId: group.spawnId,
      privacyClass: 'session_private_redacted',
      payloadJson: JSON.stringify(projection),
      expiresAt: new Date(Date.now() + ttlMs()).toISOString(),
      leaseToken,
    });
    const rows = store.listOrchestrationCheckpoints(
      group.sessionId,
      'subagent_resume',
      MAX_GROUPS_PER_SESSION + 20,
    );
    for (const row of rows.slice(MAX_GROUPS_PER_SESSION)) {
      store.removeOrchestrationCheckpoint(group.sessionId, 'subagent_resume', row.scopeId);
    }
    return saved;
  } catch {
    // Memory retention remains available in the current executor.
    return false;
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
function capTranscriptBytes(transcript: AgentMessage[]): AgentMessage[] {
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

function lruGroup(groups: Map<string, ResumableGroup>): ResumableGroup | null {
  let oldest: ResumableGroup | null = null;
  for (const g of groups.values()) {
    if (!oldest || (g.seq ?? 0) < (oldest.seq ?? 0)) oldest = g;
  }
  return oldest;
}

function sweep(sessionId: number): void {
  const groups = bySession.get(sessionId);
  if (!groups) return;
  const now = Date.now();
  const ttl = ttlMs();
  for (const [id, g] of groups) {
    if (now - g.lastTouchedAt > ttl) groups.delete(id);
  }
  // LRU count cap.
  while (groups.size > MAX_GROUPS_PER_SESSION) {
    const oldest = lruGroup(groups);
    if (!oldest) break;
    groups.delete(oldest.spawnId);
  }
  // Byte budget — evict LRU until under.
  let bytes = 0;
  const sessionCap = maxSessionBytes();
  for (const g of groups.values()) for (const a of g.agents) bytes += a.approxBytes;
  while (bytes > sessionCap && groups.size > 0) {
    const oldest = lruGroup(groups);
    if (!oldest) break;
    for (const a of oldest.agents) bytes -= a.approxBytes;
    groups.delete(oldest.spawnId);
  }
  if (groups.size === 0) bySession.delete(sessionId);
}

/**
 * Whether transcripts of COMPLETED agents are retained too. Default ON since
 * the observability work (read_agent_transcript + the dashboard Transcript
 * tab need them); `CODER_RESUME_RETAIN_COMPLETED=0` restores failed-only.
 * Byte caps (per-agent/per-session) and TTL bound the extra memory.
 */
export function retainCompletedTranscripts(): boolean {
  return process.env.CODER_RESUME_RETAIN_COMPLETED !== '0';
}

/**
 * Retain a finished spawn group. Transcripts are sanitized + byte-capped here
 * so `resume_agent` can use them verbatim. Completed agents keep theirs too
 * (observability) unless CODER_RESUME_RETAIN_COMPLETED=0.
 */
export function retainGroup(
  sessionId: number,
  group: ResumableGroup,
  store?: ResumeCheckpointStore,
): void {
  const retainCompleted = retainCompletedTranscripts();
  for (const agent of group.agents) {
    if (agent.transcript && (agent.reason !== 'completed' || retainCompleted)) {
      agent.transcript = sanitizeTranscriptForResume(agent.transcript, agent.reason);
    } else {
      agent.transcript = undefined;
    }
    agent.approxBytes = agent.transcript ? approxBytesOf(agent.transcript) : 0;
  }
  let groups = bySession.get(sessionId);
  if (!groups) {
    groups = new Map();
    bySession.set(sessionId, groups);
  }
  touch(group);
  groups.set(group.spawnId, group);
  persistGroup(store, group);
  sweep(sessionId);
}

export function getGroup(
  sessionId: number,
  spawnId: string,
  store?: ResumeCheckpointStore,
): ResumableGroup | undefined {
  sweep(sessionId);
  let group = bySession.get(sessionId)?.get(spawnId);
  if (!group && store) {
    const row = store.loadOrchestrationCheckpoint(sessionId, 'subagent_resume', spawnId);
    group = row ? parsePersistedGroup(row.payloadJson, sessionId, spawnId) : undefined;
    if (group) {
      let groups = bySession.get(sessionId);
      if (!groups) {
        groups = new Map();
        bySession.set(sessionId, groups);
      }
      groups.set(spawnId, group);
    }
  }
  if (group) touch(group);
  return group;
}

/**
 * Reload the roster after acquiring the durable lease. `getGroup` is
 * intentionally cache-first for read/observability callers, but execution
 * must discard any pre-CAS snapshot before selecting resume targets.
 */
export function reloadGroupUnderLease(
  sessionId: number,
  spawnId: string,
  store?: ResumeCheckpointStore,
): ResumableGroup | undefined {
  assertResumeLease(sessionId, spawnId, store);
  const cached = bySession.get(sessionId)?.get(spawnId);
  const leaseToken = resumeLeaseTokens.get(`${sessionId}:${spawnId}`);
  const restored = store && !leaseToken?.startsWith('compat:')
    ? (() => {
        const row = store.loadOrchestrationCheckpoint(sessionId, 'subagent_resume', spawnId);
        return row ? parsePersistedGroup(row.payloadJson, sessionId, spawnId) : undefined;
      })()
    : cached
      ? parsePersistedGroup(JSON.stringify(cached), sessionId, spawnId)
      : undefined;
  if (!restored) return undefined;
  let groups = bySession.get(sessionId);
  if (!groups) {
    groups = new Map();
    bySession.set(sessionId, groups);
  }
  touch(restored);
  groups.set(spawnId, restored);
  return restored;
}

/** Swap an agent's state after a resume attempt (failed again → new transcript/attempt). */
export function replaceAgentState(
  sessionId: number,
  spawnId: string,
  next: ResumableAgentState,
  store?: ResumeCheckpointStore,
): boolean {
  const group = bySession.get(sessionId)?.get(spawnId);
  if (!group) return false;
  const idx = group.agents.findIndex((a) => a.agentIndex === next.agentIndex);
  if (idx === -1) return false;
  if (next.transcript && (next.reason !== 'completed' || retainCompletedTranscripts())) {
    next.transcript = sanitizeTranscriptForResume(next.transcript, next.reason);
  } else {
    next.transcript = undefined;
  }
  next.approxBytes = next.transcript ? approxBytesOf(next.transcript) : 0;
  group.agents[idx] = next;
  touch(group);
  const persisted = persistGroup(store, group);
  sweep(sessionId);
  return persisted;
}

export function listResumable(
  sessionId: number,
): Array<{ spawnId: string; agentIndex: number; label: string; reason: StopReason; attempt: number }> {
  sweep(sessionId);
  const out: Array<{ spawnId: string; agentIndex: number; label: string; reason: StopReason; attempt: number }> = [];
  for (const g of bySession.get(sessionId)?.values() ?? []) {
    for (const a of g.agents) {
      // Completed agents may carry a transcript (observability retention) —
      // they are readable, never resumable.
      if (a.transcript && a.reason !== 'completed') {
        out.push({ spawnId: g.spawnId, agentIndex: a.agentIndex, label: a.label, reason: a.reason, attempt: a.attempt });
      }
    }
  }
  return out;
}

/** Groups with at least one retained transcript — feed for read_agent_transcript. */
export function listReadableGroups(
  sessionId: number,
): Array<{ spawnId: string; createdAt: number; agents: Array<{ agentIndex: number; label: string; reason: StopReason; hasTranscript: boolean }> }> {
  sweep(sessionId);
  const out: Array<{ spawnId: string; createdAt: number; agents: Array<{ agentIndex: number; label: string; reason: StopReason; hasTranscript: boolean }> }> = [];
  for (const g of bySession.get(sessionId)?.values() ?? []) {
    out.push({
      spawnId: g.spawnId,
      createdAt: g.createdAt,
      agents: g.agents.map((a) => ({
        agentIndex: a.agentIndex,
        label: a.label,
        reason: a.reason,
        hasTranscript: (a.transcript?.length ?? 0) > 0,
      })),
    });
  }
  return out.sort((a, b) => b.createdAt - a.createdAt);
}

export function clearSession(sessionId: number, store?: ResumeCheckpointStore): void {
  bySession.delete(sessionId);
  if (store) {
    for (const row of store.listOrchestrationCheckpoints(sessionId, 'subagent_resume', 200)) {
      store.removeOrchestrationCheckpoint(sessionId, 'subagent_resume', row.scopeId);
    }
  }
}

/** Per-spawnId in-flight lock so concurrent resume_agent calls can't double-run. */
export function tryAcquireResume(
  sessionId: number,
  spawnId: string,
  store?: ResumeCheckpointStore,
): boolean {
  const key = `${sessionId}:${spawnId}`;
  if (inFlightResumes.has(key)) return false;
  const duration = leaseMs();
  const leaseToken = store?.tryAcquireOrchestrationCheckpoint(
    sessionId,
    'subagent_resume',
    spawnId,
    duration,
  );
  if (store && !leaseToken) return false;
  if (leaseToken?.startsWith('compat:') && checkpointEnforced()) {
    throw new Error(`resume_agent '${spawnId}' requires migration 259 while AgentRun enforcement is enabled`);
  }
  inFlightResumes.add(key);
  if (leaseToken) {
    resumeLeaseTokens.set(key, leaseToken);
    resumeLeaseGuards.set(key, createOrchestrationLeaseGuard({
      label: `resume_agent '${spawnId}'`,
      leaseMs: duration,
      renew: () => typeof store?.renewOrchestrationCheckpoint !== 'function'
        || store.renewOrchestrationCheckpoint(
          sessionId,
          'subagent_resume',
          spawnId,
          leaseToken,
          duration,
        ),
    }));
  }
  return true;
}

/** Renew/verify the resume operation immediately before dispatch or ACK. */
export function assertResumeLease(
  sessionId: number,
  spawnId: string,
  store?: ResumeCheckpointStore,
): void {
  if (!store || typeof store.renewOrchestrationCheckpoint !== 'function') return;
  const guard = resumeLeaseGuards.get(`${sessionId}:${spawnId}`);
  if (!guard) {
    throw new Error(`resume_agent '${spawnId}' executor lease was fenced or expired`);
  }
  guard.assertOwned();
}

/** Renew the short lease while resumed children are inside provider/tools. */
export function startResumeLeaseKeepalive(
  sessionId: number,
  spawnId: string,
  store?: ResumeCheckpointStore,
  onLost?: (error: Error) => void,
): () => void {
  if (!store || typeof store.renewOrchestrationCheckpoint !== 'function') return () => {};
  const guard = resumeLeaseGuards.get(`${sessionId}:${spawnId}`);
  if (!guard) throw new Error(`resume_agent '${spawnId}' executor lease was fenced or expired`);
  return guard.start(onLost);
}

export function resumeLeaseKeepaliveActiveForTests(sessionId: number, spawnId: string): boolean {
  return resumeLeaseGuards.get(`${sessionId}:${spawnId}`)?.isRunning() ?? false;
}

export function releaseResume(
  sessionId: number,
  spawnId: string,
  store?: ResumeCheckpointStore,
): void {
  const key = `${sessionId}:${spawnId}`;
  inFlightResumes.delete(key);
  resumeLeaseGuards.get(key)?.stop();
  resumeLeaseGuards.delete(key);
  const leaseToken = resumeLeaseTokens.get(key);
  resumeLeaseTokens.delete(key);
  if (store && leaseToken) {
    store.releaseOrchestrationCheckpoint(sessionId, 'subagent_resume', spawnId, leaseToken);
  }
}
