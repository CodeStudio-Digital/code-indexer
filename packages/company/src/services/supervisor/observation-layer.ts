/**
 * AgentSupervisor — Observation Layer (Sprint 4, Phase 1.3).
 *
 * Wires the supervisor's HeartbeatTracker to the existing event
 * surfaces — `CompanyEventBus` (lifecycle of master + subordinates)
 * and `subordinateCompletionBus` (per-subordinate terminal events
 * from C5/Sprint 2). Phase 1 stops here: those two buses cover the
 * coarse-grained lifecycle (registered → terminal).
 *
 * **Out of scope for Phase 1**: subscribing to per-`CoderRunner`
 * EventEmitter events (~40 fine-grained signals like `tool_call_start`,
 * `provider_call`, `text_delta`). Wiring those requires hooking into
 * `runCoder()` boot — landing point in Phase 2 once the supervisor's
 * value is proven with coarse signals.
 *
 * **Phase 1 coverage**:
 *   - Subordinate spawn (via CompanyEventBus `subordinates.changed`)
 *     → register + transition BOOTING → RUNNING_TURN (via DB poll)
 *   - Subordinate completion (via subordinateCompletionBus)
 *     → transition to TERMINAL (with reason)
 *   - Master ended (via CompanyEventBus `master.ended`)
 *     → transition master record to TERMINAL or IDLE
 *   - Master resurrected → transition back to RUNNING_TURN
 *
 * Pure event-handler logic; no I/O of its own. Tests use mock buses.
 */
import type { HeartbeatTracker } from './heartbeat-tracker.js';
import type { CompanyEventBus, CompanyInternalEvent } from '../CompanyEventBus.js';
import type {
  SubordinateCompletionBus,
  SubordinateCompletionEvent,
} from '../subordinate/completion-events.js';
import type { SupervisionState } from './state-machine.js';
import { isTerminalState } from './state-machine.js';

/**
 * Optional callback invoked whenever the supervisor records an
 * incident (illegal transition, terminal-from-non-terminal flow, etc).
 * Hosts use this for structured logging / SSE to dashboard. Failures
 * inside the callback are caught so observability never breaks the
 * supervisor.
 */
export type IncidentEmitter = (incident: {
  kind:
    | 'illegal_transition'
    | 'unknown_agent_event'
    | 'observation_error'
    /** Periodic tick detected a state timeout — agent is stuck. */
    | 'stuck_detected'
    /** Circuit breakers (Phase 2.3) — agent recovery limit reached. */
    | 'agent_quarantined'
    /** Circuit breakers — role spawn limit reached. */
    | 'role_quarantined'
    /** Circuit breakers — read-only mode entered or exited. */
    | 'read_only_mode'
    /** Runner injected an enforcement reminder into an agent stuck in an
     *  insistent tool-call loop (same tool+args refused across cycles). */
    | 'loop_enforced';
  agentRunId: number | null;
  fromState?: SupervisionState;
  attemptedTo?: SupervisionState;
  detail: string;
  detectedAtMs: number;
}) => void;

export interface ObservationLayerDeps {
  tracker: HeartbeatTracker;
  companyEventBus: CompanyEventBus;
  completionBus: SubordinateCompletionBus;
  /** Optional incident sink. Defaults to console.warn for visibility. */
  emitIncident?: IncidentEmitter;
}

export class ObservationLayer {
  private readonly tracker: HeartbeatTracker;
  private readonly companyEventBus: CompanyEventBus;
  private readonly completionBus: SubordinateCompletionBus;
  private readonly emitIncident: IncidentEmitter;
  private readonly unsubscribers: Array<() => void> = [];
  private started = false;

  constructor(deps: ObservationLayerDeps) {
    this.tracker = deps.tracker;
    this.companyEventBus = deps.companyEventBus;
    this.completionBus = deps.completionBus;
    this.emitIncident =
      deps.emitIncident ??
      ((incident): void => {
        console.warn(
          `[supervisor] incident ${incident.kind}: agent=${incident.agentRunId ?? 'n/a'} ${incident.detail}`,
        );
      });
  }

  /**
   * Subscribe to both buses. Idempotent — calling twice is a no-op
   * (start was already called). Returns true on first call.
   */
  start(): boolean {
    if (this.started) return false;
    this.started = true;

    // CompanyEventBus — 6 event types; we handle the lifecycle ones.
    const offMasterEnded = this.companyEventBus.on('master.ended', (ev) => {
      this.safe(() => this.onMasterEnded(ev));
    });
    const offMasterResurrected = this.companyEventBus.on('master.resurrected', (ev) => {
      this.safe(() => this.onMasterResurrected(ev));
    });
    const offSubsChanged = this.companyEventBus.on('subordinates.changed', (ev) => {
      // Coarse signal — we don't change state here, but it's useful
      // for the periodic poll to know "something happened". Recorded
      // as a global heartbeat would be incorrect (no specific agent).
      // For Phase 1 we just acknowledge — Phase 2 reconciles state
      // by comparing DB rows to tracker records.
      void ev;
    });
    const offInboxReceived = this.companyEventBus.on('master.inbox_received', (ev) => {
      // Master is alive enough to process inbox — heartbeat any
      // tracked master record(s) for this session. Phase 1 has no
      // master-record discovery; this is a placeholder for Phase 2.
      void ev;
    });

    // subordinateCompletionBus — completion / failure
    const offCompletion = this.completionBus.on((ev) => {
      this.safe(() => this.onSubordinateCompletion(ev));
    });

    this.unsubscribers.push(
      offMasterEnded,
      offMasterResurrected,
      offSubsChanged,
      offInboxReceived,
      offCompletion,
    );
    return true;
  }

  /** Tear down all subscriptions. Safe to call multiple times. */
  stop(): void {
    if (!this.started) return;
    this.started = false;
    for (const off of this.unsubscribers) {
      try {
        off();
      } catch {
        // Best-effort cleanup.
      }
    }
    this.unsubscribers.length = 0;
  }

  /**
   * Manual hook for spawn events that don't yet flow through the
   * buses. The orchestrator calls this when a subordinate runner
   * boots so the supervisor starts tracking immediately. In Phase 2
   * this is replaced by hooking into `SubordinateLifecycle.spawn`.
   */
  registerSpawn(args: {
    agentRunId: number;
    companySessionId: number;
    role: string;
  }): void {
    this.tracker.register(args);
  }

  /**
   * Manual hook for the master's boot — analogous to registerSpawn
   * but for the master role. Phase 1 keeps masters in their own
   * records since they have distinct lifecycle semantics.
   */
  registerMaster(args: { agentRunId: number; companySessionId: number }): void {
    this.tracker.register({
      agentRunId: args.agentRunId,
      companySessionId: args.companySessionId,
      role: 'master',
    });
  }

  // ─── Event handlers ──────────────────────────────────────────

  private onMasterEnded(_ev: CompanyInternalEvent): void {
    // CompanyEventBus events don't carry agentRunId. Phase 1 mitigation:
    // mark every tracked master record in this session as TERMINAL.
    // Phase 2 will carry the agentRunId through the bus payload.
    for (const record of this.tracker.all()) {
      if (record.role !== 'master') continue;
      if (isTerminalState(record.state)) continue;
      const res = this.tracker.transition(record.agentRunId, 'TERMINAL');
      if (!res.applied && res.reason === 'illegal_transition') {
        this.emitIncident({
          kind: 'illegal_transition',
          agentRunId: record.agentRunId,
          fromState: res.from,
          attemptedTo: 'TERMINAL',
          detail: 'master.ended → TERMINAL rejected',
          detectedAtMs: Date.now(),
        });
      }
    }
  }

  private onMasterResurrected(_ev: CompanyInternalEvent): void {
    // Master came back. Any master record that we previously marked
    // TERMINAL needs to be re-registered as BOOTING. Since TERMINAL
    // is a sink (transition rejected), we unregister + re-register.
    for (const record of this.tracker.all()) {
      if (record.role !== 'master') continue;
      if (record.state !== 'TERMINAL') continue;
      this.tracker.unregister(record.agentRunId);
      this.tracker.register({
        agentRunId: record.agentRunId,
        companySessionId: record.companySessionId,
        role: 'master',
      });
    }
  }

  private onSubordinateCompletion(ev: SubordinateCompletionEvent): void {
    const record = this.tracker.get(ev.agentRunId);
    if (!record) {
      // We never registered this subordinate — likely happened before
      // supervisor started, or registerSpawn was missed. Emit an
      // observation_error so the wiring gap is visible.
      this.emitIncident({
        kind: 'unknown_agent_event',
        agentRunId: ev.agentRunId,
        detail: `completion event for unknown agent (outcome=${ev.outcome})`,
        detectedAtMs: ev.emittedAtMs,
      });
      return;
    }
    // Both completed and failed are terminal from the supervisor's
    // perspective — recovery happens in Phase 2 (failed → RESURRECTING).
    // Phase 1: just record and flag.
    const res = this.tracker.transition(ev.agentRunId, 'TERMINAL', ev.emittedAtMs);
    if (!res.applied && res.reason === 'illegal_transition') {
      this.emitIncident({
        kind: 'illegal_transition',
        agentRunId: ev.agentRunId,
        fromState: res.from,
        attemptedTo: 'TERMINAL',
        detail: `completion (${ev.outcome}) → TERMINAL rejected from ${res.from}`,
        detectedAtMs: ev.emittedAtMs,
      });
    }
  }

  /** Catch synchronous throws in handlers and emit as observation_error. */
  private safe(fn: () => void): void {
    try {
      fn();
    } catch (e) {
      this.emitIncident({
        kind: 'observation_error',
        agentRunId: null,
        detail: e instanceof Error ? e.message : String(e),
        detectedAtMs: Date.now(),
      });
    }
  }
}
