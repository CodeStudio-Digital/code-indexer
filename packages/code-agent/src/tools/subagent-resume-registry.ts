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
import {
  removeSessionSpill,
  removeSpillFile,
  spillTranscriptToDisk,
} from '@mcp/code-agent/tools/subagent-transcript-spill.js';
import type { SessionId } from '@mcp/session-storage';

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
/**
 * Spill COMPLETED transcripts to disk (default ON). `CODER_RESUME_SPILL=0`
 * keeps them in RAM (the pre-spill behavior). Only completed agents are ever
 * spilled — failed/aborted stay in RAM so resume_agent keeps working.
 */
function spillTerminalTranscripts(): boolean {
  return process.env.CODER_RESUME_SPILL !== '0';
}
/** How often the unref'd worker timer reclaims idle sessions (default 5min). */
function sweepIntervalMs(): number {
  const configured = Number(process.env.CODER_RESUME_SWEEP_INTERVAL_MS ?? 5 * 60_000);
  return Number.isFinite(configured) && configured >= 10_000
    ? Math.floor(configured)
    : 5 * 60_000;
}

const bySession = new Map<SessionId, Map<string, ResumableGroup>>();
const storesBySession = new Map<SessionId, ResumeCheckpointStore>();
const inFlightResumes = new Set<string>();
const resumeLeaseTokens = new Map<string, string>();
const resumeLeaseGuards = new Map<string, OrchestrationLeaseGuard>();
let touchSeq = 0;
/** Unref'd worker-realm timer that reclaims idle sessions on the TTL cadence. */
let sweepTimer: ReturnType<typeof setInterval> | null = null;

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

async function hydrateSpillPaths(
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
      // The spill pointer is a host-local filesystem path — never persist it
      // into the cross-executor checkpoint (another host has no such file).
      spillPath: undefined,
    })),
  };
  return sanitizeCheckpointValue(projected);
}

function parsePersistedGroup(
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

async function persistGroup(
  store: ResumeCheckpointStore | undefined,
  group: ResumableGroup,
): Promise<boolean> {
  if (!store || typeof store.saveOrchestrationCheckpoint !== 'function') return true;
  const key = `${group.sessionId}:${group.spawnId}`;
  const leaseToken = resumeLeaseTokens.get(key);
  const projection = durableProjection(group);
  // Keep a transcript-free completed roster as a short-lived tombstone. It
  // prevents a stale executor that loaded before the winning commit from
  // relaunching an already-completed child after it later wins the lease.
  try {
    const saved = await store.saveOrchestrationCheckpoint({
      sessionId: group.sessionId,
      kind: 'subagent_resume',
      scopeId: group.spawnId,
      privacyClass: 'session_private_redacted',
      payloadJson: JSON.stringify(projection),
      expiresAt: new Date(Date.now() + ttlMs()).toISOString(),
      leaseToken,
    });
    const rows = await store.listOrchestrationCheckpoints(
      group.sessionId,
      'subagent_resume',
      MAX_GROUPS_PER_SESSION + 20,
    );
    for (const row of rows.slice(MAX_GROUPS_PER_SESSION)) {
      await store.removeOrchestrationCheckpoint(
        group.sessionId,
        'subagent_resume',
        row.scope_id,
      );
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

/** Evict a group from RAM; bundle transcripts live until session deletion. */
function dropGroup(groups: Map<string, ResumableGroup>, group: ResumableGroup): void {
  for (const a of group.agents) if (a.spillPath) removeSpillFile(a.spillPath);
  groups.delete(group.spawnId);
}

/**
 * Spill a COMPLETED agent's (already sanitized) transcript to disk and drop it
 * from RAM, leaving a pointer + metadata. Only completed agents are spilled —
 * failed/aborted keep their in-RAM transcript so resume_agent can relaunch
 * them. A spill failure is non-fatal: the transcript simply stays in RAM.
 */
async function maybeSpillAgent(
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

function sweep(sessionId: SessionId): void {
  const groups = bySession.get(sessionId);
  if (!groups) return;
  const now = Date.now();
  const ttl = ttlMs();
  for (const g of [...groups.values()]) {
    if (now - g.lastTouchedAt > ttl) dropGroup(groups, g);
  }
  // LRU count cap.
  while (groups.size > MAX_GROUPS_PER_SESSION) {
    const oldest = lruGroup(groups);
    if (!oldest) break;
    dropGroup(groups, oldest);
  }
  // Byte budget — evict LRU until under.
  let bytes = 0;
  const sessionCap = maxSessionBytes();
  for (const g of groups.values()) for (const a of g.agents) bytes += a.approxBytes;
  while (bytes > sessionCap && groups.size > 0) {
    const oldest = lruGroup(groups);
    if (!oldest) break;
    for (const a of oldest.agents) bytes -= a.approxBytes;
    dropGroup(groups, oldest);
  }
  if (groups.size === 0) bySession.delete(sessionId);
}

/** Sweep every session — the body of the periodic worker-realm timer. */
function sweepAllSessions(): void {
  for (const sessionId of [...bySession.keys()]) sweep(sessionId);
}

/**
 * Start the periodic sweep once (idempotent). Unref'd so it never keeps the
 * worker alive, and lazy so a process that never retains a group pays nothing.
 * Without it, the 45-min TTL only fires on the next registry access, so a warm
 * session that goes idle would pin its RAM until the whole worker is evicted.
 */
function ensureSweepTimer(): void {
  if (sweepTimer) return;
  sweepTimer = setInterval(sweepAllSessions, sweepIntervalMs());
  sweepTimer.unref?.();
}

/** Test hook: stop the timer so a suite leaves no lingering interval. */
export function stopResumeSweepForTests(): void {
  if (sweepTimer) clearInterval(sweepTimer);
  sweepTimer = null;
}

/** Test hook: RAM group count for a session WITHOUT triggering a lazy sweep. */
export function peekSessionGroupCountForTests(sessionId: SessionId): number {
  return bySession.get(sessionId)?.size ?? 0;
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
 * so `resume_agent` can use them verbatim. Completed agents' transcripts are
 * spilled to disk (read via read_agent_transcript) unless
 * CODER_RESUME_RETAIN_COMPLETED=0 (dropped) or CODER_RESUME_SPILL=0 (kept in
 * RAM); failed/aborted transcripts stay resident so resume can relaunch them.
 * Arms the periodic worker-realm sweep so idle sessions are reclaimed on time.
 */
export async function retainGroup(
  sessionId: SessionId,
  group: ResumableGroup,
  store?: ResumeCheckpointStore,
): Promise<void> {
  if (store) storesBySession.set(sessionId, store);
  const retainCompleted = retainCompletedTranscripts();
  for (const agent of group.agents) {
    if (agent.transcript && (agent.reason !== 'completed' || retainCompleted)) {
      agent.transcript = sanitizeTranscriptForResume(agent.transcript, agent.reason);
    } else {
      agent.transcript = undefined;
    }
    // Spill completed transcripts to disk (drops them from RAM) so approxBytes
    // below reflects only what actually stays resident.
    await maybeSpillAgent(store, sessionId, group.spawnId, agent);
    agent.approxBytes = agent.transcript ? approxBytesOf(agent.transcript) : 0;
  }
  let groups = bySession.get(sessionId);
  if (!groups) {
    groups = new Map();
    bySession.set(sessionId, groups);
  }
  touch(group);
  groups.set(group.spawnId, group);
  await persistGroup(store, group);
  ensureSweepTimer();
  sweep(sessionId);
}

export async function getGroup(
  sessionId: SessionId,
  spawnId: string,
  store?: ResumeCheckpointStore,
): Promise<ResumableGroup | undefined> {
  const durableStore = store ?? storesBySession.get(sessionId);
  if (store) storesBySession.set(sessionId, store);
  sweep(sessionId);
  let group = bySession.get(sessionId)?.get(spawnId);
  if (!group && durableStore) {
    const checkpoint = await durableStore.loadOrchestrationCheckpoint(
      sessionId,
      'subagent_resume',
      spawnId,
    );
    group = checkpoint
      ? parsePersistedGroup(
          checkpoint.payload_json,
          sessionId,
          spawnId,
        )
      : undefined;
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
  if (group) await hydrateSpillPaths(group, durableStore);
  return group;
}

/**
 * Reload the roster after acquiring the durable lease. `getGroup` is
 * intentionally cache-first for read/observability callers, but execution
 * must discard any pre-CAS snapshot before selecting resume targets.
 */
export async function reloadGroupUnderLease(
  sessionId: SessionId,
  spawnId: string,
  store?: ResumeCheckpointStore,
): Promise<ResumableGroup | undefined> {
  await assertResumeLease(sessionId, spawnId, store);
  const cached = bySession.get(sessionId)?.get(spawnId);
  const leaseToken = resumeLeaseTokens.get(`${sessionId}:${spawnId}`);
  const restored = store
    ? (() => store
        .loadOrchestrationCheckpoint(
          sessionId,
          'subagent_resume',
          spawnId,
        )
        .then((checkpoint) =>
          checkpoint
            ? parsePersistedGroup(
                checkpoint.payload_json,
                sessionId,
                spawnId,
              )
            : undefined,
        ))()
    : cached
      ? parsePersistedGroup(JSON.stringify(cached), sessionId, spawnId)
      : undefined;
  const resolved = await restored;
  if (!resolved) return undefined;
  // The durable checkpoint strips the host-local spill pointer, so carry it
  // forward from this worker's cache — otherwise a store-backed reload would
  // orphan the spilled files and lose completed-agent readability post-resume.
  if (cached) {
    const spillByIndex = new Map(cached.agents.map((a) => [a.agentIndex, a.spillPath]));
    for (const a of resolved.agents) {
      if (!a.spillPath && !a.transcript) a.spillPath = spillByIndex.get(a.agentIndex);
    }
  }
  await hydrateSpillPaths(resolved, store);
  let groups = bySession.get(sessionId);
  if (!groups) {
    groups = new Map();
    bySession.set(sessionId, groups);
  }
  touch(resolved);
  groups.set(spawnId, resolved);
  return resolved;
}

/** Swap an agent's state after a resume attempt (failed again → new transcript/attempt). */
export async function replaceAgentState(
  sessionId: SessionId,
  spawnId: string,
  next: ResumableAgentState,
  store?: ResumeCheckpointStore,
): Promise<boolean> {
  const group = bySession.get(sessionId)?.get(spawnId);
  if (!group) return false;
  const idx = group.agents.findIndex((a) => a.agentIndex === next.agentIndex);
  if (idx === -1) return false;
  const prevSpill = group.agents[idx].spillPath;
  if (prevSpill && prevSpill !== next.spillPath) removeSpillFile(prevSpill);
  if (next.transcript && (next.reason !== 'completed' || retainCompletedTranscripts())) {
    next.transcript = sanitizeTranscriptForResume(next.transcript, next.reason);
  } else {
    next.transcript = undefined;
  }
  await maybeSpillAgent(store, sessionId, spawnId, next);
  next.approxBytes = next.transcript ? approxBytesOf(next.transcript) : 0;
  group.agents[idx] = next;
  touch(group);
  const persisted = await persistGroup(store, group);
  sweep(sessionId);
  return persisted;
}

export function listResumable(
  sessionId: SessionId,
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
export async function listReadableGroups(
  sessionId: SessionId,
  store?: ResumeCheckpointStore,
): Promise<Array<{ spawnId: string; createdAt: number; agents: Array<{ agentIndex: number; label: string; reason: StopReason; hasTranscript: boolean }> }>> {
  const durableStore = store ?? storesBySession.get(sessionId);
  if (durableStore) {
    for (const checkpoint of await durableStore.listOrchestrationCheckpoints(
      sessionId,
      'subagent_resume',
      MAX_GROUPS_PER_SESSION,
    )) {
      await getGroup(sessionId, checkpoint.scope_id, durableStore);
    }
  }
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
        // A spilled (completed) transcript is still readable via its pointer.
        hasTranscript: (a.transcript?.length ?? 0) > 0 || !!a.spillPath,
      })),
    });
  }
  return out.sort((a, b) => b.createdAt - a.createdAt);
}

export async function clearSession(
  sessionId: SessionId,
  _store?: ResumeCheckpointStore,
): Promise<void> {
  bySession.delete(sessionId);
  removeSessionSpill(sessionId);
  storesBySession.delete(sessionId);
}

/** Per-spawnId in-flight lock so concurrent resume_agent calls can't double-run. */
export async function tryAcquireResume(
  sessionId: SessionId,
  spawnId: string,
  store?: ResumeCheckpointStore,
): Promise<boolean> {
  const key = `${sessionId}:${spawnId}`;
  if (inFlightResumes.has(key)) return false;
  const duration = leaseMs();
  const leaseToken = store
    ? await store.tryAcquireOrchestrationCheckpoint(
        sessionId,
        'subagent_resume',
        spawnId,
        duration,
      )
    : undefined;
  if (store && !leaseToken) return false;
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
export async function assertResumeLease(
  sessionId: SessionId,
  spawnId: string,
  store?: ResumeCheckpointStore,
): Promise<void> {
  if (!store || typeof store.renewOrchestrationCheckpoint !== 'function') return;
  const guard = resumeLeaseGuards.get(`${sessionId}:${spawnId}`);
  if (!guard) {
    throw new Error(`resume_agent '${spawnId}' executor lease was fenced or expired`);
  }
  await guard.assertOwned();
}

/** Renew the short lease while resumed children are inside provider/tools. */
export function startResumeLeaseKeepalive(
  sessionId: SessionId,
  spawnId: string,
  store?: ResumeCheckpointStore,
  onLost?: (error: Error) => void,
): () => void {
  if (!store || typeof store.renewOrchestrationCheckpoint !== 'function') return () => {};
  const guard = resumeLeaseGuards.get(`${sessionId}:${spawnId}`);
  if (!guard) throw new Error(`resume_agent '${spawnId}' executor lease was fenced or expired`);
  return guard.start(onLost);
}

export function resumeLeaseKeepaliveActiveForTests(
  sessionId: SessionId,
  spawnId: string,
): boolean {
  return resumeLeaseGuards.get(`${sessionId}:${spawnId}`)?.isRunning() ?? false;
}

export async function releaseResume(
  sessionId: SessionId,
  spawnId: string,
  store?: ResumeCheckpointStore,
): Promise<void> {
  const key = `${sessionId}:${spawnId}`;
  inFlightResumes.delete(key);
  resumeLeaseGuards.get(key)?.stop();
  resumeLeaseGuards.delete(key);
  const leaseToken = resumeLeaseTokens.get(key);
  resumeLeaseTokens.delete(key);
  if (store && leaseToken) {
    await store.releaseOrchestrationCheckpoint(
      sessionId,
      'subagent_resume',
      spawnId,
      leaseToken,
    );
  }
}
