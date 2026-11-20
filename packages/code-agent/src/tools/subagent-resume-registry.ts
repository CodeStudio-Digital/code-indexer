import { maybeSpillAgent } from './subagent-resume-spill.js';
import { hydrateSpillPaths, approxBytesOf, durableProjection, parsePersistedGroup, sanitizeTranscriptForResume } from './subagent-resume-codec.js';
export { sanitizeTranscriptForResume } from './subagent-resume-codec.js';
import { maxSessionBytes, ttlMs, spillTerminalTranscripts, sweepIntervalMs, retainCompletedTranscripts, configureResumeSettings } from './subagent-resume-settings.js';
export { retainCompletedTranscripts } from './subagent-resume-settings.js';
import type { ResumableAgentState, ResumableGroup, ResumeRegistryConfiguration, ResumeCheckpointStore } from './subagent-resume-types.js';
export type { ResumableAgentState, ResumableGroup, ResumeCheckpointStore } from './subagent-resume-types.js';
/**
 * subagent-resume-registry — session-keyed retention of finished ephemeral
 * subagents (transcript preserved) for the Transcript tab; the resume_agent
 * relaunch it was built for is retired.
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

import { removeSpillFile } from '@mcp/code-agent/tools/subagent-transcript-spill.js';
import type { SessionId } from '@mcp/session-storage';

export function resumeNeedsReconciliation(state: Pick<ResumableAgentState, 'effectOutcome' | 'failureNote' | 'transcript'>): boolean {
  return state.effectOutcome === 'unknown' || /outcome[_ ]unknown/i.test(state.failureNote ?? '')
    || !!state.transcript?.some(message => message.role === 'tool'
      && message.content.some(block => block.type === 'tool_result' && block.effect_outcome === 'unknown'));
}

const MAX_GROUPS_PER_SESSION = 8;

const bySession = new Map<SessionId, Map<string, ResumableGroup>>();
const storesBySession = new Map<SessionId, ResumeCheckpointStore>();
let touchSeq = 0;
/** Unref'd worker-realm timer that reclaims idle sessions on the TTL cadence. */
let sweepTimer: ReturnType<typeof setInterval> | null = null;

/** Stamp freshness — wall-clock for TTL, monotonic seq for deterministic LRU. */
function touch(group: ResumableGroup): void {
  group.lastTouchedAt = Date.now();
  group.seq = ++touchSeq;
}

async function persistGroup(
  store: ResumeCheckpointStore | undefined,
  group: ResumableGroup,
): Promise<boolean> {
  if (!store || typeof store.saveOrchestrationCheckpoint !== 'function') return true;
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
    });
    // RAM is bounded by sweep(); resume authority expires through the durable
    // TTL. Keep the redacted roster on disk to locate audit transcripts after
    // eviction. Deleting it strands bundle files.
    return saved;
  } catch {
    // Memory retention remains available in the current executor.
    return false;
  }
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

/** Test-only explicit configuration; production always uses immutable defaults. */
export function configureResumeRegistryForTests(
  overrides: Partial<ResumeRegistryConfiguration> | null,
): void {
  stopResumeSweepForTests();
  configureResumeSettings(overrides);
}

/** Test hook: RAM group count for a session WITHOUT triggering a lazy sweep. */
export function peekSessionGroupCountForTests(sessionId: SessionId): number {
  return bySession.get(sessionId)?.size ?? 0;
}

/**
 * Retain a finished spawn group. Transcripts are sanitized + byte-capped here
 * so they stay provider-safe. Completed agents' transcripts are
 * spilled to disk (read by the Transcript tab) unless
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

/** Audit reads neither refresh TTL nor populate the resumable in-memory cache. */
export async function getReadableGroup(sessionId: SessionId, spawnId: string,
  store?: ResumeCheckpointStore): Promise<ResumableGroup | undefined> {
  const durableStore = store ?? storesBySession.get(sessionId);
  sweep(sessionId);
  const resident = bySession.get(sessionId)?.get(spawnId);
  if (resident) { await hydrateSpillPaths(resident, durableStore); return resident; }
  if (!durableStore?.loadOrchestrationCheckpointForAudit) return getGroup(sessionId, spawnId, store);
  const checkpoint = await durableStore.loadOrchestrationCheckpointForAudit(sessionId, 'subagent_resume', spawnId);
  const group = checkpoint ? parsePersistedGroup(checkpoint.payload_json, sessionId, spawnId) : undefined;
  if (group) await hydrateSpillPaths(group, durableStore);
  return group;
}

/** Test hook: forget a session's in-memory groups as a recreated executor would (bundle files stay). */
export function forgetResumeSessionForTests(sessionId: SessionId): void {
  bySession.delete(sessionId);
  storesBySession.delete(sessionId);
}
