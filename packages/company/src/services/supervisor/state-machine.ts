/**
 * AgentSupervisor — State Machine (Sprint 4, Phase 1.1).
 *
 * Pure types + transition table + validator. No I/O, no side effects.
 * Imported by the heartbeat tracker, observation layer, and the
 * supervisor singleton. Tested in isolation.
 *
 * **Design intent**: separates "what the agent is doing"
 * (`agent_runs.status`, owned by Master/Subordinate lifecycle) from
 * "what the supervisor expects + last confirmed via heartbeat"
 * (`SupervisionState`). They CAN diverge — the supervisor uses that
 * divergence + heartbeat staleness to detect stuck states.
 *
 * Mirrors the formal state-machine pattern from
 * `xai-org/x-algorithm/grox/tasks/task.py` (DISABLE_RULES + retry
 * idempotente) but applied to agent lifecycle instead of task scheduling.
 */

/**
 * Every state has a meaning, a default timeout (how long the supervisor
 * waits before flagging the state as "stuck"), and which states it can
 * legally transition to. Transitions outside the table are rejected
 * and surfaced as `illegal_transition` incidents.
 */
export type SupervisionState =
  /** runCoder() called, awaiting first runner event. */
  | 'BOOTING'
  /** Runner emitted turn_start; processing a turn. */
  | 'RUNNING_TURN'
  /** provider_call emitted; waiting for first delta. */
  | 'AWAITING_PROVIDER'
  /** tool_call_start emitted; waiting for tool_call_result. */
  | 'AWAITING_TOOL'
  /** Master posted a question or plan and is waiting for the user. */
  | 'AWAITING_HUMAN'
  /** Subordinate is `waiting_plan` / `waiting_question` / `waiting_tasks`. */
  | 'AWAITING_MASTER_APPROVAL'
  /** Send with wait=true; pending inbox answer. */
  | 'AWAITING_INBOX_ANSWER'
  /** Subordinate `waiting`, ready for next task; no timeout. */
  | 'IDLE'
  /** Recovery action in progress. */
  | 'RESURRECTING'
  /** Too many recovery failures; cooldown before respawn. */
  | 'QUARANTINED'
  /** completed / aborted / permanent error; no timeout. */
  | 'TERMINAL'
  /** Stuck-state variants. Distinct so incident type carries the reason. */
  | 'STUCK_BOOT'
  | 'STUCK_TURN'
  | 'STUCK_PROVIDER'
  | 'STUCK_TOOL'
  | 'STUCK_AWAITING_MASTER'
  | 'INBOX_EXPIRED'
  | 'FAILED_BOOT'
  | 'FAILED_RESURRECT';

/**
 * Default timeout per state. Tunable via Decider keys
 * `supervisor.timeoutMs.<state>` — admin can override per-tier/session
 * via `config_json.pipelines.supervisor.timeoutMs.AWAITING_TOOL` etc.
 *
 * `null` means "no timeout" — supervisor never flags this state as
 * stuck (e.g. IDLE, TERMINAL).
 *
 * Numbers in ms. Match the plan's recovery thresholds.
 */
export const DEFAULT_STATE_TIMEOUT_MS: Readonly<Record<SupervisionState, number | null>> =
  Object.freeze({
    BOOTING: 90_000, // 90s
    RUNNING_TURN: 5 * 60_000, // 5min
    AWAITING_PROVIDER: null, // The provider transport owns deadlines and retries, including silent reasoning.
    AWAITING_TOOL: 5 * 60_000, // 5min (tool-tier-aware multiplier applied at observation time)
    AWAITING_HUMAN: null,
    AWAITING_MASTER_APPROVAL: 30 * 60_000, // 30min
    AWAITING_INBOX_ANSWER: 20 * 60_000, // 20min (= legacy inbox wait timeout)
    IDLE: null,
    RESURRECTING: 90_000, // 90s
    QUARANTINED: 5 * 60_000, // 5min cooldown
    TERMINAL: null,
    // Stuck variants don't have their own timeout — they transition
    // into RESURRECTING or QUARANTINED based on the recovery action.
    STUCK_BOOT: null,
    STUCK_TURN: null,
    STUCK_PROVIDER: null,
    STUCK_TOOL: null,
    STUCK_AWAITING_MASTER: null,
    INBOX_EXPIRED: null,
    FAILED_BOOT: null,
    FAILED_RESURRECT: null,
  });

/**
 * Transition table. Each state lists its allowed successors. The
 * supervisor validates EVERY transition against this map; calls that
 * don't match are rejected and surfaced as an `illegal_transition`
 * incident (likely an observer wiring bug).
 *
 * TERMINAL is a sink — once reached, no transitions out (the agent
 * row is GC'd, and a new spawn creates a new supervision record).
 */
export const LEGAL_TRANSITIONS: Readonly<Record<SupervisionState, ReadonlySet<SupervisionState>>> =
  Object.freeze({
    BOOTING: new Set<SupervisionState>(['RUNNING_TURN', 'AWAITING_PROVIDER', 'AWAITING_HUMAN', 'FAILED_BOOT', 'TERMINAL', 'STUCK_BOOT']),
    RUNNING_TURN: new Set<SupervisionState>([
      'AWAITING_PROVIDER',
      'AWAITING_TOOL',
      'AWAITING_HUMAN',
      'AWAITING_MASTER_APPROVAL',
      'AWAITING_INBOX_ANSWER',
      'IDLE',
      'TERMINAL',
      'STUCK_TURN',
    ]),
    AWAITING_PROVIDER: new Set<SupervisionState>([
      'RUNNING_TURN',
      'AWAITING_HUMAN',
      'TERMINAL',
      'STUCK_PROVIDER',
    ]),
    AWAITING_TOOL: new Set<SupervisionState>(['RUNNING_TURN', 'AWAITING_HUMAN', 'TERMINAL', 'STUCK_TOOL']),
    AWAITING_HUMAN: new Set<SupervisionState>(['RUNNING_TURN', 'AWAITING_TOOL', 'TERMINAL']),
    AWAITING_MASTER_APPROVAL: new Set<SupervisionState>([
      'RUNNING_TURN',
      'TERMINAL',
      'STUCK_AWAITING_MASTER',
    ]),
    AWAITING_INBOX_ANSWER: new Set<SupervisionState>([
      'RUNNING_TURN',
      'TERMINAL',
      'INBOX_EXPIRED',
    ]),
    IDLE: new Set<SupervisionState>(['RUNNING_TURN', 'BOOTING', 'TERMINAL']),
    RESURRECTING: new Set<SupervisionState>(['RUNNING_TURN', 'QUARANTINED', 'TERMINAL']),
    QUARANTINED: new Set<SupervisionState>(['IDLE', 'TERMINAL']),
    TERMINAL: new Set<SupervisionState>(),
    // Stuck variants flow into recovery. QUARANTINED is reachable from
    // every STUCK_* because the per-agent circuit breaker (Phase 2.3)
    // may trip from any of them when recoveries keep failing.
    STUCK_BOOT: new Set<SupervisionState>(['RESURRECTING', 'QUARANTINED', 'TERMINAL']),
    STUCK_TURN: new Set<SupervisionState>(['RESURRECTING', 'QUARANTINED', 'TERMINAL']),
    STUCK_PROVIDER: new Set<SupervisionState>(['RESURRECTING', 'QUARANTINED', 'TERMINAL']),
    STUCK_TOOL: new Set<SupervisionState>(['RUNNING_TURN', 'RESURRECTING', 'QUARANTINED', 'TERMINAL']),
    STUCK_AWAITING_MASTER: new Set<SupervisionState>([
      'IDLE',
      'RESURRECTING',
      'QUARANTINED',
      'TERMINAL',
    ]),
    INBOX_EXPIRED: new Set<SupervisionState>(['RUNNING_TURN', 'IDLE', 'QUARANTINED', 'TERMINAL']),
    FAILED_BOOT: new Set<SupervisionState>(['QUARANTINED', 'TERMINAL']),
    FAILED_RESURRECT: new Set<SupervisionState>(['QUARANTINED', 'TERMINAL']),
  });

/**
 * Returns true when `to` is a legal next state from `from`. Same-state
 * "transitions" (state → state) always pass — they represent heartbeat
 * refreshes, not transitions.
 */
export function isLegalTransition(from: SupervisionState, to: SupervisionState): boolean {
  if (from === to) return true; // heartbeat refresh
  const allowed = LEGAL_TRANSITIONS[from];
  return allowed?.has(to) ?? false;
}

/**
 * The 8 STUCK_* / FAILED_* states. Helper for filtering incidents.
 */
const STUCK_STATES: ReadonlySet<SupervisionState> = new Set<SupervisionState>([
  'STUCK_BOOT',
  'STUCK_TURN',
  'STUCK_PROVIDER',
  'STUCK_TOOL',
  'STUCK_AWAITING_MASTER',
  'INBOX_EXPIRED',
  'FAILED_BOOT',
  'FAILED_RESURRECT',
]);

export function isStuckState(s: SupervisionState): boolean {
  return STUCK_STATES.has(s);
}

/** TERMINAL — supervisor stops tracking. */
export function isTerminalState(s: SupervisionState): boolean {
  return s === 'TERMINAL';
}

/**
 * Mapping from a transient state to its corresponding STUCK_* sibling.
 * Used by the periodic tick when a timeout fires: e.g. AWAITING_TOOL
 * → STUCK_TOOL. States without a stuck mapping (IDLE, TERMINAL) never
 * time out so they don't appear here.
 */
export const STUCK_VARIANT_OF: Readonly<Partial<Record<SupervisionState, SupervisionState>>> =
  Object.freeze({
    BOOTING: 'STUCK_BOOT',
    RUNNING_TURN: 'STUCK_TURN',
    AWAITING_TOOL: 'STUCK_TOOL',
    AWAITING_MASTER_APPROVAL: 'STUCK_AWAITING_MASTER',
    AWAITING_INBOX_ANSWER: 'INBOX_EXPIRED',
    RESURRECTING: 'FAILED_RESURRECT',
  });
