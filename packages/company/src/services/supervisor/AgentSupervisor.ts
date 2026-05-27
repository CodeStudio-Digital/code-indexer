/**
 * AgentSupervisor — singleton (Sprint 4, Phase 1.4).
 *
 * Composes the heartbeat tracker + observation layer + periodic
 * stuck-detection tick into one orchestrated unit. Hosts construct
 * exactly one of these at boot, call `start()`, and forget about it
 * — the supervisor wires itself to the buses and runs its own
 * background loop.
 *
 * **Phase 1 (this file)**:
 *   - Detects stuck states (via `tracker.detectStuck()`)
 *   - Emits structured incidents (no recovery actions yet)
 *   - Exposes `getStatus()` for dashboard polling
 *   - Lifecycle: `start()` / `stop()` idempotent
 *
 * **Phase 2** will add:
 *   - Recovery action dispatch (resurrectMaster, abortStuckTool, etc.)
 *   - Persistence via the agent_supervision SQLite table
 *   - Circuit breakers
 *
 * **Phase 3** will add:
 *   - SSE topic for dashboard
 *   - Decider-driven timeout overrides
 *   - Anomaly detection
 */
import { HeartbeatTracker, type AgentSupervisionRecord, type StuckAgent } from './heartbeat-tracker.js';
import { ObservationLayer, type IncidentEmitter } from './observation-layer.js';
import type { CompanyEventBus } from '../CompanyEventBus.js';
import type { SubordinateCompletionBus } from '../subordinate/completion-events.js';
import { isStuckState, isTerminalState, type SupervisionState } from './state-machine.js';
import { dispatchRecovery, type RecoveryContext, type RecoveryOutcome } from './recovery-actions.js';
import {
  CircuitBreakers,
  configFromEnv,
  type BreakerStatusSnapshot,
  type CircuitBreakerConfig,
  type RoleQuarantineInfo,
} from './circuit-breakers.js';
import {
  detectGhostRunning,
  type IncidentQueryRow,
  type PersistedIncident,
  type SupervisionPersistence,
} from './persistence.js';

export interface AgentSupervisorDeps {
  companyEventBus: CompanyEventBus;
  completionBus: SubordinateCompletionBus;
  /** Optional sink for incidents — defaults to console.warn. */
  emitIncident?: IncidentEmitter;
  /** Optional override for periodic tick interval (ms). Default 15s. */
  tickIntervalMs?: number;
  /**
   * Sprint 4 Phase 2.2 — handles to orchestrator services that
   * recovery actions need (master.resurrect, subordinates.resume,
   * per-agent runners). When undefined, recovery is disabled and
   * stuck states only emit incidents.
   */
  recoveryContext?: RecoveryContext;
  /**
   * Sprint 4 Phase 2.3 — circuit breaker thresholds. When undefined,
   * defaults from env (MCP_SUPERVISOR_*) merged with hard defaults.
   * Pass an explicit partial config to override in tests.
   */
  circuitBreakerConfig?: Partial<CircuitBreakerConfig>;
  /**
   * Sprint 4 Phase 2.4 — persistence layer. When provided, the
   * supervisor:
   *   1. Calls `loadAll()` on start() to rehydrate state from disk
   *   2. Detects ghost_running rows (state non-terminal + stale heartbeat
   *      past `ghostStaleThresholdMs`) → flips them to TERMINAL +
   *      emits incidents
   *   3. Persists every state transition + incident
   *   4. Batches heartbeat flushes on each tick
   *
   * When omitted, supervisor operates in-memory only (Phase 2.3 mode).
   */
  persistence?: SupervisionPersistence;
  /**
   * How long after last heartbeat a non-terminal record is considered
   * ghost on boot. Default 5min — matches the observation watchdog
   * threshold. Tunable for tests.
   */
  ghostStaleThresholdMs?: number;
}

const DEFAULT_TICK_INTERVAL_MS = 15_000;
const DEFAULT_GHOST_STALE_THRESHOLD_MS = 5 * 60_000; // 5min

/**
 * Diagnostic snapshot for dashboards / admin endpoints. Read-only;
 * computed on demand.
 */
export interface SupervisorStatus {
  isRunning: boolean;
  trackedCount: number;
  byState: Record<string, number>;
  stuckCount: number;
  totalIncidents: number;
  lastTickAtMs: number | null;
  tickCount: number;
  /** Phase 2.3 — current circuit breaker state. */
  breakers: BreakerStatusSnapshot;
}

export class AgentSupervisor {
  private readonly tracker: HeartbeatTracker;
  private readonly observation: ObservationLayer;
  private readonly emitIncidentRaw: IncidentEmitter;
  private readonly emitIncident: IncidentEmitter;
  private readonly tickIntervalMs: number;
  private readonly recoveryContext: RecoveryContext | null;
  private readonly breakers: CircuitBreakers;
  private readonly persistence: SupervisionPersistence | null;
  private readonly ghostStaleThresholdMs: number;
  private hydrated = false;
  private tickTimer: ReturnType<typeof setInterval> | null = null;
  private lastTickAtMs: number | null = null;
  private tickCount = 0;
  /** Last tick's stuck-agent ids — used for dedup so the same stuck
   *  doesn't emit an incident every tick. */
  private alreadyFlaggedThisRun = new Set<number>();
  /** Tracks read-only mode entries we've already announced so we
   *  don't spam `read_only_mode` incidents on every tick. */
  private readOnlyAnnouncedUntilMs: number | null = null;

  constructor(deps: AgentSupervisorDeps) {
    this.tracker = new HeartbeatTracker();
    this.emitIncidentRaw =
      deps.emitIncident ??
      ((incident): void => {
        console.warn(
          `[supervisor] incident ${incident.kind}: agent=${incident.agentRunId ?? 'n/a'} ${incident.detail}`,
        );
      });
    this.persistence = deps.persistence ?? null;
    this.tracker.setPersistence(this.persistence);
    // Mirror every incident to persistence (when wired) before forwarding
    // to the host's emitter. Failures don't propagate — supervisor must
    // stay reachable even if persistence is dead.
    this.emitIncident = (incident): void => {
      if (this.persistence) {
        try {
          const persisted: PersistedIncident = {
            agentRunId: incident.agentRunId ?? null,
            companySessionId: this.companySessionFor(incident.agentRunId ?? null),
            incidentKind: incident.kind,
            fromState: incident.fromState ?? null,
            attemptedToState: incident.attemptedTo ?? null,
            detail: incident.detail,
            detectedAtMs: incident.detectedAtMs,
          };
          this.persistence.saveIncident(persisted);
        } catch {
          /* best-effort */
        }
      }
      this.emitIncidentRaw(incident);
    };
    this.observation = new ObservationLayer({
      tracker: this.tracker,
      companyEventBus: deps.companyEventBus,
      completionBus: deps.completionBus,
      emitIncident: this.emitIncident,
    });
    this.tickIntervalMs = deps.tickIntervalMs ?? DEFAULT_TICK_INTERVAL_MS;
    this.recoveryContext = deps.recoveryContext ?? null;
    // Merge: hard defaults ← env overrides ← explicit deps overrides.
    this.breakers = new CircuitBreakers({ ...configFromEnv(), ...(deps.circuitBreakerConfig ?? {}) });
    this.ghostStaleThresholdMs = deps.ghostStaleThresholdMs ?? DEFAULT_GHOST_STALE_THRESHOLD_MS;
  }

  /** Lookup company_session_id for an agent so persisted incidents
   *  carry it. Returns null when the agent isn't currently tracked. */
  private companySessionFor(agentRunId: number | null): number | null {
    if (agentRunId == null) return null;
    return this.tracker.get(agentRunId)?.companySessionId ?? null;
  }

  /**
   * Start observation + periodic tick. Idempotent — returns false
   * when already started. The first tick fires immediately so tests
   * + dashboard don't have to wait for the interval.
   *
   * Phase 2.4 — on first start, rehydrates from persistence (if wired)
   * and detects ghost_running rows (process died mid-flight). The
   * supervisor cleans those up before the periodic loop begins.
   */
  start(): boolean {
    if (this.tickTimer) return false;
    if (!this.hydrated) {
      this.hydrateFromPersistence();
      this.hydrated = true;
    }
    this.observation.start();
    // Initial tick for fast feedback.
    void this.tickOnce();
    this.tickTimer = setInterval(() => {
      void this.tickOnce();
    }, this.tickIntervalMs);
    if (typeof (this.tickTimer as { unref?: () => unknown }).unref === 'function') {
      (this.tickTimer as { unref: () => unknown }).unref();
    }
    return true;
  }

  /**
   * Read all rows from persistence, rehydrate the tracker, and clean
   * up `ghost_running` records. A ghost is any non-terminal state
   * whose `lastHeartbeatAt` is older than `ghostStaleThresholdMs` at
   * boot time — the process that owned it didn't survive restart.
   *
   * Pure side-effecting bootstrap. Safe to call manually for tests.
   */
  hydrateFromPersistence(nowMs: number = Date.now()): {
    rehydrated: number;
    ghosts: number;
  } {
    if (!this.persistence) return { rehydrated: 0, ghosts: 0 };
    let rows: AgentSupervisionRecord[] = [];
    try {
      rows = this.persistence.loadAll();
    } catch (e) {
      this.emitIncident({
        kind: 'observation_error',
        agentRunId: null,
        detail: `persistence.loadAll threw: ${e instanceof Error ? e.message : String(e)}`,
        detectedAtMs: nowMs,
      });
      return { rehydrated: 0, ghosts: 0 };
    }
    const rehydrated = this.tracker.hydrate(rows);
    const ghosts = detectGhostRunning(rows, nowMs, this.ghostStaleThresholdMs);
    for (const g of ghosts) {
      // Skip if already terminal (defensive — detectGhostRunning excludes
      // TERMINAL/IDLE, but a defensive check costs nothing).
      if (isTerminalState(g.state)) continue;
      const res = this.tracker.transition(g.agentRunId, 'TERMINAL', nowMs);
      this.emitIncident({
        kind: 'stuck_detected',
        agentRunId: g.agentRunId,
        fromState: g.state,
        attemptedTo: 'TERMINAL',
        detail:
          `ghost_running on boot: agent ${g.agentRunId} (${g.role}) was in ${g.state} ` +
          `with last heartbeat ${Math.round((nowMs - g.lastHeartbeatAt) / 1000)}s ago. ` +
          (res.applied
            ? `Marked TERMINAL.`
            : `TERMINAL transition rejected (${res.reason}).`),
        detectedAtMs: nowMs,
      });
    }
    return { rehydrated, ghosts: ghosts.length };
  }

  /** Stop both observation + periodic tick. Idempotent. */
  stop(): void {
    if (this.tickTimer) {
      clearInterval(this.tickTimer);
      this.tickTimer = null;
    }
    this.observation.stop();
  }

  /**
   * Register a freshly-spawned subordinate so the supervisor starts
   * tracking it. Called by `SubordinateLifecycle.spawn()` in Phase 1.5.
   */
  registerSubordinate(args: {
    agentRunId: number;
    companySessionId: number;
    role: string;
  }): void {
    this.observation.registerSpawn(args);
  }

  /**
   * Register a freshly-booted master so the supervisor starts
   * tracking it. Called by `MasterLifecycle.start()` in Phase 1.5.
   */
  registerMaster(args: { agentRunId: number; companySessionId: number }): void {
    this.observation.registerMaster(args);
  }

  /**
   * Manual state transition entry point. Used by callers that have
   * fine-grained state knowledge the bus doesn't carry (e.g.
   * SubordinateLifecycle knows when a subordinate enters
   * `waiting_plan` from the HumanInTheLoop intercept).
   *
   * Returns true on applied transition. Emits `illegal_transition`
   * incident when rejected.
   */
  transition(
    agentRunId: number,
    toState: SupervisionState,
    payload?: { toolUseId?: string | null; toolName?: string | null },
  ): boolean {
    const res = this.tracker.transition(agentRunId, toState, Date.now(), payload);
    if (!res.applied && res.reason === 'illegal_transition') {
      this.emitIncident({
        kind: 'illegal_transition',
        agentRunId,
        fromState: res.from,
        attemptedTo: toState,
        detail: `manual transition rejected from ${res.from}`,
        detectedAtMs: Date.now(),
      });
    }
    return res.applied;
  }

  /** Bump heartbeat for the agent (any observable activity). */
  heartbeat(agentRunId: number): boolean {
    return this.tracker.heartbeat(agentRunId);
  }

  /**
   * Phase 3.4 — override the per-state timeout for one agent. Used by
   * anomaly detection (`wireSupervisorToRunner`) when a tool's baseline
   * is tighter than the default. Pass null to clear.
   */
  setStateTimeoutOverride(agentRunId: number, ms: number | null): boolean {
    return this.tracker.setStateTimeoutOverride(agentRunId, ms);
  }

  /**
   * Inspect the current supervisor state. Useful for `/api/admin/supervisor/status`.
   */
  getStatus(nowMs: number = Date.now()): SupervisorStatus {
    const records = this.tracker.all();
    const byState: Record<string, number> = {};
    let stuck = 0;
    let totalIncidents = 0;
    for (const r of records) {
      byState[r.state] = (byState[r.state] ?? 0) + 1;
      if (isStuckState(r.state)) stuck++;
      totalIncidents += r.incidentCount;
    }
    return {
      isRunning: this.tickTimer !== null,
      trackedCount: records.length,
      byState,
      stuckCount: stuck,
      totalIncidents,
      lastTickAtMs: this.lastTickAtMs,
      tickCount: this.tickCount,
      breakers: this.breakers.status(nowMs),
    };
  }

  /**
   * Phase 2.3 — spawn-time gate. Returns quarantine info when the role
   * is currently quarantined (caller should refuse new spawns until
   * `quarantinedUntilMs`). Returns null when the role is free.
   */
  isRoleQuarantined(role: string, nowMs: number = Date.now()): RoleQuarantineInfo | null {
    return this.breakers.getRoleQuarantine(role, nowMs);
  }

  /**
   * Operator override — release a role from quarantine. Emits an
   * incident for audit trail. Returns true when the role was actually
   * quarantined before the call.
   */
  releaseRoleQuarantine(role: string): boolean {
    const had = this.breakers.releaseRole(role);
    if (had) {
      this.emitIncident({
        kind: 'role_quarantined',
        agentRunId: null,
        detail: `OPERATOR RELEASE: role ${role} quarantine cleared`,
        detectedAtMs: Date.now(),
      });
    }
    return had;
  }

  /** Operator override — exit read-only mode. */
  releaseReadOnlyMode(): boolean {
    const was = this.breakers.releaseReadOnly();
    if (was) {
      this.readOnlyAnnouncedUntilMs = null;
      this.emitIncident({
        kind: 'read_only_mode',
        agentRunId: null,
        detail: 'OPERATOR RELEASE: read-only mode cleared',
        detectedAtMs: Date.now(),
      });
    }
    return was;
  }

  /** Test helper — list current records. */
  listRecords(): ReadonlyArray<AgentSupervisionRecord> {
    return this.tracker.all();
  }

  /**
   * Public entry for the periodic stuck-detection tick. Returns the
   * list of stuck agents detected this tick (after dedup against
   * prior ticks). Exposed for tests + admin/debug endpoints.
   *
   * Phase 1: just emits incidents + flips state to STUCK_*. No
   * recovery actions — those land in Phase 2.
   */
  async tickOnce(nowMs: number = Date.now()): Promise<StuckAgent[]> {
    this.tickCount += 1;
    this.lastTickAtMs = nowMs;
    // Phase 2.4 — flush heartbeats from in-memory to persistence in batch.
    // Cheap when persistence is NullSupervisionPersistence (no-op).
    if (this.persistence) {
      try {
        this.persistence.saveHeartbeats(this.tracker.heartbeatSnapshot());
      } catch {
        /* best-effort */
      }
    }
    const stuck = this.tracker.detectStuck(nowMs);
    const fresh: StuckAgent[] = [];
    for (const s of stuck) {
      if (this.alreadyFlaggedThisRun.has(s.record.agentRunId)) continue;
      fresh.push(s);
      this.alreadyFlaggedThisRun.add(s.record.agentRunId);
      // Transition to STUCK_*.
      const res = this.tracker.transition(s.record.agentRunId, s.toStuckState, nowMs);
      // Record incident regardless of transition outcome — caller
      // needs to know about the stuck-ness even if the transition
      // wasn't legal (which would itself be a bug).
      this.tracker.recordIncident(s.record.agentRunId);
      // Stuck detections use the dedicated `stuck_detected` kind so
      // observers can route them differently from genuine illegal
      // transitions (which are observer-wiring bugs).
      const kind: 'stuck_detected' | 'illegal_transition' = res.applied
        ? 'stuck_detected'
        : 'illegal_transition';
      this.emitIncident({
        kind,
        agentRunId: s.record.agentRunId,
        fromState: s.fromState,
        attemptedTo: s.toStuckState,
        detail: !res.applied
          ? `stuck-detection transition ${s.fromState}→${s.toStuckState} REJECTED`
          : `stuck detected after ${Math.round(s.ageMs / 1000)}s in ${s.fromState}; transitioned to ${s.toStuckState}`,
        detectedAtMs: nowMs,
      });

      // Phase 2.3 — every incident bumps the global breaker counter.
      // Tripping the global breaker silences recovery for `globalReadOnlyMs`.
      const tripped = this.breakers.recordIncident(nowMs);
      if (tripped && this.readOnlyAnnouncedUntilMs !== nowMs + this.breakers.getConfig().globalReadOnlyMs) {
        this.readOnlyAnnouncedUntilMs = nowMs + this.breakers.getConfig().globalReadOnlyMs;
        this.emitIncident({
          kind: 'read_only_mode',
          agentRunId: null,
          detail:
            `global incident rate exceeded ${this.breakers.getConfig().globalLimit} / ` +
            `${Math.round(this.breakers.getConfig().globalWindowMs / 1000)}s — ` +
            `recovery disabled for ${Math.round(this.breakers.getConfig().globalReadOnlyMs / 1000)}s`,
          detectedAtMs: nowMs,
        });
      }

      // Phase 2.2 — try a recovery action. Only attempted when a
      // RecoveryContext was wired AND the transition was applied
      // (rejected transitions indicate a deeper bug; don't pile a
      // recovery on top). Fire-and-forget per agent — we don't await
      // here because actions are independent + may take seconds.
      // Phase 2.3 — skip when in read-only mode (still emits the
      // stuck incident above so the dashboard sees the pattern).
      if (res.applied && this.recoveryContext && !this.breakers.isReadOnlyMode(nowMs)) {
        // eslint-disable-next-line @typescript-eslint/no-floating-promises
        this.runRecoveryActionFor(s, nowMs);
      }
    }
    return fresh;
  }

  /**
   * Run the dispatcher for one stuck agent. Logs the outcome as an
   * incident sidecar event (same emitter as stuck detections so the
   * dashboard sees the whole chain in one stream).
   *
   * Errors from individual actions are caught and converted to
   * `recovery_failed` incidents — the supervisor must never crash on
   * a misbehaving action.
   */
  private async runRecoveryActionFor(stuck: StuckAgent, nowMs: number): Promise<void> {
    if (!this.recoveryContext) return;
    const agentRunId = stuck.record.agentRunId;
    const role = stuck.record.role;
    try {
      this.tracker.recordRecoveryAttempt(agentRunId);
      const outcome: RecoveryOutcome | null = await dispatchRecovery(
        stuck,
        this.recoveryContext,
      );
      if (!outcome) {
        // No action registered for this state — silent skip is fine.
        return;
      }
      this.emitIncident({
        kind: 'stuck_detected',
        agentRunId,
        fromState: stuck.fromState,
        attemptedTo: stuck.toStuckState,
        detail: outcome.ok
          ? `recovery_action ${outcome.action} SUCCESS: ${outcome.detail}`
          : `recovery_action ${outcome.action} ${outcome.reason ?? 'failed'}: ${outcome.detail}`,
        detectedAtMs: nowMs,
      });
      // Phase 2.3 — non-ok outcomes count against the per-agent +
      // per-role breakers. `no_match` is excluded because it just means
      // the action didn't apply (not a real failure).
      const isRealFailure =
        !outcome.ok && outcome.reason !== 'no_match';
      if (isRealFailure) {
        this.recordRecoveryFailure(agentRunId, role, stuck.fromState, nowMs);
      } else if (outcome.ok) {
        // Successful recovery — clear stuck dedup so re-detection
        // can fire if the agent gets stuck again later. Recovery
        // attempts counter NOT cleared (history is still relevant
        // for tripping the breaker on chronic agents).
        this.alreadyFlaggedThisRun.delete(agentRunId);
      }
    } catch (e) {
      this.emitIncident({
        kind: 'observation_error',
        agentRunId,
        fromState: stuck.fromState,
        detail: `recovery dispatcher threw: ${e instanceof Error ? e.message : String(e)}`,
        detectedAtMs: nowMs,
      });
      // Dispatcher throwing = unambiguous failure.
      this.recordRecoveryFailure(agentRunId, role, stuck.fromState, nowMs);
    }
  }

  /**
   * Bookkeeping for one failed recovery: bumps per-agent + per-role
   * breakers, emits quarantine incidents when limits trip, and
   * transitions the agent into QUARANTINED when the per-agent breaker
   * fires (so it stops getting picked up by `detectStuck`).
   */
  private recordRecoveryFailure(
    agentRunId: number,
    role: string,
    fromState: SupervisionState,
    nowMs: number,
  ): void {
    const agentTripped = this.breakers.recordAgentFailure(agentRunId, nowMs);
    const roleTripped = this.breakers.recordRoleFailure(role, nowMs);
    if (agentTripped) {
      // Try to transition to QUARANTINED — the tracker validates the
      // transition; it's legal from any STUCK_* / FAILED_* state.
      const cur = this.tracker.get(agentRunId);
      if (cur && cur.state !== 'QUARANTINED' && cur.state !== 'TERMINAL') {
        const res = this.tracker.transition(agentRunId, 'QUARANTINED', nowMs);
        if (!res.applied) {
          // Transition rejected (e.g. agent already past stuck). Still
          // record the incident so the operator sees the breaker fired.
          this.emitIncident({
            kind: 'illegal_transition',
            agentRunId,
            fromState: res.from,
            attemptedTo: 'QUARANTINED',
            detail: 'breaker tripped but QUARANTINED transition rejected',
            detectedAtMs: nowMs,
          });
        }
      }
      this.emitIncident({
        kind: 'agent_quarantined',
        agentRunId,
        fromState,
        attemptedTo: 'QUARANTINED',
        detail:
          `agent ${agentRunId} (${role}) tripped breaker: ` +
          `${this.breakers.getConfig().agentLimit} failed recoveries in ` +
          `${Math.round(this.breakers.getConfig().agentWindowMs / 1000)}s — quarantined`,
        detectedAtMs: nowMs,
      });
    }
    if (roleTripped) {
      const info = this.breakers.getRoleQuarantine(role, nowMs);
      const untilStr = info ? new Date(info.quarantinedUntilMs).toISOString() : 'unknown';
      this.emitIncident({
        kind: 'role_quarantined',
        agentRunId: null,
        detail:
          `role ${role} tripped breaker: ` +
          `${this.breakers.getConfig().roleLimit} failures in ` +
          `${Math.round(this.breakers.getConfig().roleWindowMs / 1000)}s — ` +
          `spawn refused until ${untilStr}`,
        detectedAtMs: nowMs,
      });
    }
  }

  /**
   * Test helper — clears the dedup set so a previously-flagged stuck
   * agent can be re-detected. Production callers shouldn't need this.
   */
  clearStuckDedupForTests(): void {
    this.alreadyFlaggedThisRun.clear();
  }

  /** Test helper — direct breaker reset. */
  clearBreakersForTests(): void {
    this.breakers.clearAllForTests();
    this.readOnlyAnnouncedUntilMs = null;
  }

  /**
   * Phase 2.4 — dashboard / admin helper. Returns persisted incidents
   * for one company session, newest first. Returns `[]` when no
   * persistence wired (Phase 2.3 mode).
   */
  listRecentIncidents(sessionId: number, limit: number = 50): IncidentQueryRow[] {
    if (!this.persistence) return [];
    try {
      return this.persistence.listRecentIncidents(sessionId, limit);
    } catch {
      return [];
    }
  }
}
