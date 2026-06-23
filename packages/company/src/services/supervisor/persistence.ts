/**
 * AgentSupervisor — Persistence interface (Sprint 4 Phase 2.4).
 *
 * Cross-restart durability for supervisor state. The interface is
 * deliberately thin so:
 *   - Production wires a SQLite impl (`SqliteSupervisionPersistence`).
 *   - Tests use a no-op or in-memory impl without dragging better-sqlite3.
 *   - The supervisor's hot path (heartbeats) stays IN-MEMORY — only the
 *     periodic tick flushes the batched heartbeat timestamps to disk.
 *
 * **What persists**:
 *   - One row per `agent_run_id` in `agent_supervision`
 *   - One incident row per stuck/quarantine/recovery event
 *
 * **What does NOT persist** (still in-memory only):
 *   - CircuitBreakers state (sliding windows) — counters are "recent
 *     activity" + windows are short (1-10min). Lost in restart, but
 *     QUARANTINED supervision states DO persist, so quarantined agents
 *     stay quarantined when the process boots.
 *
 * The recovered-on-boot path uses `loadAll()` + `detectGhostRunning()`.
 * Anything in `RUNNING_TURN` / `AWAITING_*` / `BOOTING` with a stale
 * heartbeat after restart is `ghost_running` — the process holding
 * that run is gone. Supervisor flips it to `TERMINAL` + emits incident.
 */
import type { AgentSupervisionRecord } from './heartbeat-tracker.js';
import type { SupervisionState } from './state-machine.js';

/**
 * Serialised form of an incident, written to `agent_supervision_incidents`.
 * Mirrors the `IncidentEmitter` payload + adds resolution columns.
 */
export interface PersistedIncident {
  agentRunId: number | null;
  companySessionId: number | null;
  incidentKind: string;
  fromState: SupervisionState | null;
  attemptedToState: SupervisionState | null;
  detail: string;
  /** Optional structured diagnostic JSON. Serialised to TEXT. */
  diagnosticJson?: string | null;
  /** Action attempted (when this incident is recovery-related). */
  recoveryAction?: string | null;
  /** 'success' | 'failed' | 'queued' — when known at write time. */
  recoveryOutcome?: 'success' | 'failed' | 'queued' | null;
  detectedAtMs: number;
}

/**
 * Recent-incidents query result. Returned in the order the caller
 * passed (typically `detected_at DESC`).
 */
export interface IncidentQueryRow extends PersistedIncident {
  id: number;
  resolvedAtMs: number | null;
}

/**
 * Persistence port. The supervisor depends on this; the worker / host
 * picks the impl. `null` is a valid value everywhere — when wired with
 * no persistence the supervisor degrades to in-memory only (Phase 2.3
 * behaviour) without any other change.
 */
export interface SupervisionPersistence {
  /** Read every tracked supervision record. Called once on boot. */
  loadAll(): AgentSupervisionRecord[];

  /**
   * UPSERT one record (matches by agentRunId). Called on register +
   * state transition + counter changes.
   */
  saveRecord(record: AgentSupervisionRecord): void;

  /**
   * Batched write of `last_heartbeat_at` for many records at once.
   * The periodic tick calls this with every active record to flush
   * heartbeat updates that didn't go through `saveRecord` (heartbeats
   * are the hot path; we don't write them one-by-one).
   */
  saveHeartbeats(
    records: ReadonlyArray<{ agentRunId: number; lastHeartbeatAt: number }>,
  ): void;

  /** Remove the row. Called on unregister or operator cleanup. */
  deleteRecord(agentRunId: number): void;

  /** Append a new incident row. Fire-and-forget from the supervisor. */
  saveIncident(incident: PersistedIncident): void;

  /**
   * Mark an incident resolved (e.g. recovery succeeded after attempt).
   * Optional — supervisor doesn't currently call it; reserved for
   * Phase 3 dashboard / admin tooling.
   */
  resolveIncident?(incidentId: number, resolvedAtMs: number): void;

  /**
   * Read recent incidents for one company session. Used by the admin
   * endpoint / dashboard. Phase 2.4 ships the query; UI is Phase 3.
   */
  listRecentIncidents(sessionId: number, limit: number): IncidentQueryRow[];
}

/**
 * No-op persistence. Used in tests + when persistence is intentionally
 * disabled. All methods are inert; `loadAll()` returns `[]`.
 */
export class NullSupervisionPersistence implements SupervisionPersistence {
  loadAll(): AgentSupervisionRecord[] {
    return [];
  }
  saveRecord(_record: AgentSupervisionRecord): void {
    /* no-op */
  }
  saveHeartbeats(_records: ReadonlyArray<{ agentRunId: number; lastHeartbeatAt: number }>): void {
    /* no-op */
  }
  deleteRecord(_agentRunId: number): void {
    /* no-op */
  }
  saveIncident(_incident: PersistedIncident): void {
    /* no-op */
  }
  listRecentIncidents(_sessionId: number, _limit: number): IncidentQueryRow[] {
    return [];
  }
}

/**
 * Identify rows that were `RUNNING_TURN` / `AWAITING_*` / `BOOTING` /
 * `RESURRECTING` when the process died — their last heartbeat is now
 * older than `staleThresholdMs` because no live process is bumping it.
 *
 * Pure function — given a list and a clock, returns the subset to
 * flip into `TERMINAL` on boot.
 */
export function detectGhostRunning(
  records: ReadonlyArray<AgentSupervisionRecord>,
  nowMs: number,
  staleThresholdMs: number,
): AgentSupervisionRecord[] {
  const ghostable: ReadonlySet<SupervisionState> = new Set<SupervisionState>([
    'BOOTING',
    'RUNNING_TURN',
    'AWAITING_PROVIDER',
    'AWAITING_TOOL',
    'AWAITING_MASTER_APPROVAL',
    'AWAITING_INBOX_ANSWER',
    'RESURRECTING',
  ]);
  const ghosts: AgentSupervisionRecord[] = [];
  for (const r of records) {
    if (!ghostable.has(r.state)) continue;
    if (nowMs - r.lastHeartbeatAt < staleThresholdMs) continue;
    ghosts.push(r);
  }
  return ghosts;
}
