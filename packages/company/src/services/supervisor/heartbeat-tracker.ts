/**
 * AgentSupervisor — Heartbeat Tracker (Sprint 4, Phase 1.2).
 *
 * In-memory store mapping `agentRunId` → live supervision record.
 * Pure data layer: no I/O, no event subscription, no decisions.
 * Owned by the supervisor singleton; consumed by the observation
 * layer and the periodic stuck-detection tick.
 *
 * **Why a separate module**: keeps the supervisor's three concerns
 * (data / observation / decisions) testable in isolation. The tracker
 * is pure synchronous code; everything else builds on top.
 *
 * **Cross-restart persistence** lives in Phase 2 via the
 * `agent_supervision` SQLite table. Phase 1 is intentionally
 * in-memory only — surviving a process crash isn't required for the
 * foundation; it's a Phase 2 hardening step.
 */
import {
  DEFAULT_STATE_TIMEOUT_MS,
  isLegalTransition,
  isStuckState,
  isTerminalState,
  STUCK_VARIANT_OF,
  type SupervisionState,
} from './state-machine.js';
import type { SupervisionPersistence } from './persistence.js';

/** Per-agent supervisory record. */
export interface AgentSupervisionRecord {
  agentRunId: number;
  companySessionId: number;
  role: string;
  state: SupervisionState;
  /** Wall-clock ms when the agent ENTERED the current state. */
  enteredAt: number;
  /** Wall-clock ms of the last observable event from this agent. */
  lastHeartbeatAt: number;
  /** Current tool's `tool_use_id` when state=AWAITING_TOOL. Else null. */
  currentToolUseId: string | null;
  /** Current tool's name when state=AWAITING_TOOL. Else null. */
  currentToolName: string | null;
  /** Per-state timeout override (admin / decider). Null = use default table. */
  stateTimeoutMsOverride: number | null;
  /** Count of recovery attempts since creation. */
  recoveryAttempts: number;
  /** Total incidents detected since creation. */
  incidentCount: number;
}

/**
 * The result of attempting a state transition. Useful for tests + the
 * observation layer that needs to know if a transition actually
 * applied vs. was rejected as illegal.
 */
export interface TransitionResult {
  applied: boolean;
  /** Set when applied=false. */
  reason?: 'unknown_agent' | 'illegal_transition' | 'terminal_sink';
  /** Previous state (when applied). */
  from?: SupervisionState;
  /** Current state after the call (always set). */
  to: SupervisionState;
}

/**
 * The shape returned by `detectStuck()`. Each entry indicates an
 * agent whose `lastHeartbeatAt + effectiveTimeout < now`. The
 * supervisor's periodic tick uses this list to emit incidents and
 * (in Phase 2) dispatch recovery actions.
 */
export interface StuckAgent {
  record: AgentSupervisionRecord;
  /** State the agent was in when stuck was detected. */
  fromState: SupervisionState;
  /** STUCK_* variant the supervisor should transition the agent into. */
  toStuckState: SupervisionState;
  /** ms since lastHeartbeatAt. */
  ageMs: number;
}

export class HeartbeatTracker {
  private readonly records = new Map<number, AgentSupervisionRecord>();
  /** Optional persistence — when set, every mutation is mirrored to DB. */
  private persistence: SupervisionPersistence | null = null;

  /**
   * Attach a persistence layer (Phase 2.4). Idempotent. The tracker
   * stays usable without persistence — wiring is purely additive.
   * Should be called once before any register/transition activity so
   * the boot-time `loadAll` happens at the caller's discretion.
   */
  setPersistence(persistence: SupervisionPersistence | null): void {
    this.persistence = persistence;
  }

  /**
   * Hydrate the in-memory map from a list of records (typically read
   * via `persistence.loadAll()` at boot). Existing records are
   * preserved — duplicates skip. Returns the count actually added.
   */
  hydrate(records: ReadonlyArray<AgentSupervisionRecord>): number {
    let added = 0;
    for (const r of records) {
      if (this.records.has(r.agentRunId)) continue;
      // Defensive copy so external mutation can't corrupt our state.
      this.records.set(r.agentRunId, { ...r });
      added++;
    }
    return added;
  }

  /**
   * Register a brand-new agent in `BOOTING` state. Returns the
   * created record. If the agent is already tracked, returns the
   * existing record without overwriting (idempotent — duplicate
   * spawn events shouldn't reset state).
   */
  register(
    args: { agentRunId: number; companySessionId: number; role: string },
    nowMs: number = Date.now(),
  ): AgentSupervisionRecord {
    const existing = this.records.get(args.agentRunId);
    if (existing) return existing;
    const record: AgentSupervisionRecord = {
      agentRunId: args.agentRunId,
      companySessionId: args.companySessionId,
      role: args.role,
      state: 'BOOTING',
      enteredAt: nowMs,
      lastHeartbeatAt: nowMs,
      currentToolUseId: null,
      currentToolName: null,
      stateTimeoutMsOverride: null,
      recoveryAttempts: 0,
      incidentCount: 0,
    };
    this.records.set(args.agentRunId, record);
    this.persist(record);
    return record;
  }

  /** Look up an agent. Returns null when not tracked. */
  get(agentRunId: number): AgentSupervisionRecord | null {
    return this.records.get(agentRunId) ?? null;
  }

  /** Iterate all tracked agents. Caller MUST NOT mutate the returned records. */
  all(): ReadonlyArray<AgentSupervisionRecord> {
    return [...this.records.values()];
  }

  size(): number {
    return this.records.size;
  }

  /**
   * Heartbeat-only update: bumps `lastHeartbeatAt` without changing
   * state. The most common operation — every observable event from a
   * healthy agent (text_delta, tool_progress, etc.) calls this.
   */
  heartbeat(agentRunId: number, nowMs: number = Date.now()): boolean {
    const record = this.records.get(agentRunId);
    if (!record) return false;
    record.lastHeartbeatAt = nowMs;
    return true;
  }

  /**
   * Attempt a state transition. Validates against `LEGAL_TRANSITIONS`;
   * rejects illegal transitions (caller is expected to log them as
   * `illegal_transition` incidents). Heartbeat is always bumped on
   * applied transitions.
   *
   * Same-state "transitions" pass through as heartbeat refreshes.
   */
  transition(
    agentRunId: number,
    toState: SupervisionState,
    nowMs: number = Date.now(),
    payload?: { toolUseId?: string | null; toolName?: string | null },
  ): TransitionResult {
    const record = this.records.get(agentRunId);
    if (!record) return { applied: false, reason: 'unknown_agent', to: toState };
    const from = record.state;
    if (isTerminalState(from) && from !== toState) {
      return { applied: false, reason: 'terminal_sink', from, to: from };
    }
    if (!isLegalTransition(from, toState)) {
      return { applied: false, reason: 'illegal_transition', from, to: from };
    }
    record.state = toState;
    if (from !== toState) record.enteredAt = nowMs;
    record.lastHeartbeatAt = nowMs;
    // Tool context only set when entering AWAITING_TOOL — cleared otherwise.
    if (toState === 'AWAITING_TOOL') {
      record.currentToolUseId = payload?.toolUseId ?? null;
      record.currentToolName = payload?.toolName ?? null;
    } else {
      record.currentToolUseId = null;
      record.currentToolName = null;
    }
    // Persist on REAL transitions (state change). Same-state heartbeat
    // refreshes are NOT persisted here — the supervisor's tick flushes
    // them in batch via `saveHeartbeats`.
    if (from !== toState) this.persist(record);
    return { applied: true, from, to: toState };
  }

  /**
   * Increment incident counter for the agent. Returns the new count
   * (so the caller can implement "after N incidents, escalate").
   */
  recordIncident(agentRunId: number): number {
    const record = this.records.get(agentRunId);
    if (!record) return 0;
    record.incidentCount += 1;
    this.persist(record);
    return record.incidentCount;
  }

  /** Increment recovery attempts counter. Used by circuit breakers. */
  recordRecoveryAttempt(agentRunId: number): number {
    const record = this.records.get(agentRunId);
    if (!record) return 0;
    record.recoveryAttempts += 1;
    this.persist(record);
    return record.recoveryAttempts;
  }

  /**
   * Stop tracking an agent. Called when state transitions to TERMINAL
   * AND the run is gone (no further events expected). Phase 1 keeps
   * the record in memory for diagnostics; Phase 2 syncs to DB then
   * evicts after a TTL.
   */
  unregister(agentRunId: number): boolean {
    const had = this.records.delete(agentRunId);
    if (had) {
      try {
        this.persistence?.deleteRecord(agentRunId);
      } catch {
        /* best-effort */
      }
    }
    return had;
  }

  /**
   * Phase 3.4 — override the per-state timeout for a single agent.
   * Used by anomaly detection: when a tool's baseline shows p90 well
   * under the default timeout, the supervisor narrows the window so
   * a hung call is caught early. Pass `null` to clear (restore default).
   *
   * Returns true on apply. Persisted via the normal write-through.
   */
  setStateTimeoutOverride(agentRunId: number, ms: number | null): boolean {
    const record = this.records.get(agentRunId);
    if (!record) return false;
    record.stateTimeoutMsOverride = ms;
    this.persist(record);
    return true;
  }

  /**
   * Snapshot of (agentRunId, lastHeartbeatAt) for non-terminal records.
   * Used by the supervisor's periodic tick to batch-write heartbeats
   * to disk without persisting on every event.
   */
  heartbeatSnapshot(): Array<{ agentRunId: number; lastHeartbeatAt: number }> {
    const out: Array<{ agentRunId: number; lastHeartbeatAt: number }> = [];
    for (const r of this.records.values()) {
      if (isTerminalState(r.state)) continue;
      out.push({ agentRunId: r.agentRunId, lastHeartbeatAt: r.lastHeartbeatAt });
    }
    return out;
  }

  /** Internal — best-effort persistence. Never throws. */
  private persist(record: AgentSupervisionRecord): void {
    if (!this.persistence) return;
    try {
      this.persistence.saveRecord(record);
    } catch {
      // Persistence failure must never break the supervisor.
    }
  }

  /** Test helper — clears all records. Production code should never call. */
  clearForTests(): void {
    this.records.clear();
  }

  /**
   * Scan every tracked agent for stuck states. An agent is "stuck"
   * when its current state has a timeout AND `now - lastHeartbeatAt`
   * exceeds it. Returns the list of agents that need to be flipped
   * into their STUCK_* sibling.
   *
   * Pure read — does NOT mutate records. Caller (periodic tick) is
   * responsible for applying the transition and emitting the incident.
   */
  detectStuck(nowMs: number = Date.now()): StuckAgent[] {
    const out: StuckAgent[] = [];
    for (const record of this.records.values()) {
      // Already stuck — don't re-detect (would dedupe at observer level too).
      if (isStuckState(record.state)) continue;
      if (isTerminalState(record.state)) continue;
      const effective = record.stateTimeoutMsOverride ?? DEFAULT_STATE_TIMEOUT_MS[record.state];
      if (effective === null) continue; // no timeout for this state
      const age = nowMs - record.lastHeartbeatAt;
      if (age <= effective) continue; // still within budget
      const stuckVariant = STUCK_VARIANT_OF[record.state];
      if (!stuckVariant) continue; // safety: should be set when timeout is non-null
      out.push({
        record,
        fromState: record.state,
        toStuckState: stuckVariant,
        ageMs: age,
      });
    }
    return out;
  }
}
