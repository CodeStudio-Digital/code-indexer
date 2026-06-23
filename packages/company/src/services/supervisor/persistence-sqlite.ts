/**
 * SQLite-backed implementation of `SupervisionPersistence`.
 *
 * Schema is owned by `packages/store/src/migrations/107_agent_supervision.ts`.
 * This file is the read/write surface; it opens its own better-sqlite3
 * handle (like CompanyStore + AppSettingsStore) so the supervisor can
 * persist independently of the host's wiring choices.
 *
 * All writes are synchronous (better-sqlite3 is sync). `saveIncident`
 * is callable from any context — failures inside the supervisor's
 * fire-and-forget emitter are caught at the emitter level.
 */
import { createRequire } from 'node:module';
import type DatabaseConstructor from 'better-sqlite3';
import type { AgentSupervisionRecord } from './heartbeat-tracker.js';
import type { SupervisionState } from './state-machine.js';
import type {
  IncidentQueryRow,
  PersistedIncident,
  SupervisionPersistence,
} from './persistence.js';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3') as typeof DatabaseConstructor;
type DB = InstanceType<typeof Database>;

interface SupervisionRow {
  agent_run_id: number;
  company_session_id: number;
  role: string;
  supervision_state: string;
  state_entered_at: string;
  last_heartbeat_at: string;
  current_tool_use_id: string | null;
  current_tool_name: string | null;
  state_timeout_ms_override: number | null;
  recovery_attempts: number;
  incident_count: number;
}

interface IncidentRow {
  id: number;
  agent_run_id: number | null;
  company_session_id: number | null;
  incident_kind: string;
  from_state: string | null;
  attempted_to_state: string | null;
  detail: string;
  diagnostic_json: string | null;
  recovery_action: string | null;
  recovery_outcome: string | null;
  detected_at: string;
  resolved_at: string | null;
}

function isoToMs(iso: string): number {
  // SQLite `datetime('now')` returns UTC ISO without trailing Z.
  // Date.parse tolerates both forms.
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : 0;
}

function msToIso(ms: number): string {
  return new Date(ms).toISOString();
}

export class SqliteSupervisionPersistence implements SupervisionPersistence {
  private readonly db: DB;
  private readonly stmtUpsert: ReturnType<DB['prepare']>;
  private readonly stmtHeartbeat: ReturnType<DB['prepare']>;
  private readonly stmtDelete: ReturnType<DB['prepare']>;
  private readonly stmtLoadAll: ReturnType<DB['prepare']>;
  private readonly stmtInsertIncident: ReturnType<DB['prepare']>;
  private readonly stmtResolveIncident: ReturnType<DB['prepare']>;
  private readonly stmtListIncidents: ReturnType<DB['prepare']>;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');

    this.stmtUpsert = this.db.prepare(`
      INSERT INTO agent_supervision (
        agent_run_id, company_session_id, role, supervision_state,
        state_entered_at, last_heartbeat_at,
        current_tool_use_id, current_tool_name, state_timeout_ms_override,
        recovery_attempts, incident_count, updated_at
      ) VALUES (
        @agent_run_id, @company_session_id, @role, @supervision_state,
        @state_entered_at, @last_heartbeat_at,
        @current_tool_use_id, @current_tool_name, @state_timeout_ms_override,
        @recovery_attempts, @incident_count, datetime('now')
      )
      ON CONFLICT(agent_run_id) DO UPDATE SET
        supervision_state         = excluded.supervision_state,
        state_entered_at          = excluded.state_entered_at,
        last_heartbeat_at         = excluded.last_heartbeat_at,
        current_tool_use_id       = excluded.current_tool_use_id,
        current_tool_name         = excluded.current_tool_name,
        state_timeout_ms_override = excluded.state_timeout_ms_override,
        recovery_attempts         = excluded.recovery_attempts,
        incident_count            = excluded.incident_count,
        updated_at                = datetime('now')
    `);

    this.stmtHeartbeat = this.db.prepare(`
      UPDATE agent_supervision
         SET last_heartbeat_at = @last_heartbeat_at,
             updated_at        = datetime('now')
       WHERE agent_run_id = @agent_run_id
    `);

    this.stmtDelete = this.db.prepare(`
      DELETE FROM agent_supervision WHERE agent_run_id = ?
    `);

    this.stmtLoadAll = this.db.prepare(`
      SELECT
        agent_run_id, company_session_id, role, supervision_state,
        state_entered_at, last_heartbeat_at,
        current_tool_use_id, current_tool_name,
        state_timeout_ms_override, recovery_attempts, incident_count
      FROM agent_supervision
    `);

    this.stmtInsertIncident = this.db.prepare(`
      INSERT INTO agent_supervision_incidents (
        agent_run_id, company_session_id, incident_kind,
        from_state, attempted_to_state, detail, diagnostic_json,
        recovery_action, recovery_outcome, detected_at
      ) VALUES (
        @agent_run_id, @company_session_id, @incident_kind,
        @from_state, @attempted_to_state, @detail, @diagnostic_json,
        @recovery_action, @recovery_outcome, @detected_at
      )
    `);

    this.stmtResolveIncident = this.db.prepare(`
      UPDATE agent_supervision_incidents
         SET resolved_at = @resolved_at
       WHERE id = @id
    `);

    this.stmtListIncidents = this.db.prepare(`
      SELECT id, agent_run_id, company_session_id, incident_kind,
             from_state, attempted_to_state, detail, diagnostic_json,
             recovery_action, recovery_outcome, detected_at, resolved_at
        FROM agent_supervision_incidents
       WHERE company_session_id = ?
       ORDER BY detected_at DESC
       LIMIT ?
    `);
  }

  loadAll(): AgentSupervisionRecord[] {
    // Cast through unknown — better-sqlite3 d.ts in some versions
    // requires a bound-params arg even for parameterless statements.
    const rows = (this.stmtLoadAll as unknown as { all(): SupervisionRow[] }).all();
    return rows.map(this.rowToRecord);
  }

  saveRecord(record: AgentSupervisionRecord): void {
    this.stmtUpsert.run({
      agent_run_id: record.agentRunId,
      company_session_id: record.companySessionId,
      role: record.role,
      supervision_state: record.state,
      state_entered_at: msToIso(record.enteredAt),
      last_heartbeat_at: msToIso(record.lastHeartbeatAt),
      current_tool_use_id: record.currentToolUseId,
      current_tool_name: record.currentToolName,
      state_timeout_ms_override: record.stateTimeoutMsOverride,
      recovery_attempts: record.recoveryAttempts,
      incident_count: record.incidentCount,
    });
  }

  saveHeartbeats(
    records: ReadonlyArray<{ agentRunId: number; lastHeartbeatAt: number }>,
  ): void {
    if (records.length === 0) return;
    const stmt = this.stmtHeartbeat;
    this.db.transaction(() => {
      for (const r of records) {
        stmt.run({
          agent_run_id: r.agentRunId,
          last_heartbeat_at: msToIso(r.lastHeartbeatAt),
        });
      }
    })();
  }

  deleteRecord(agentRunId: number): void {
    this.stmtDelete.run(agentRunId);
  }

  saveIncident(incident: PersistedIncident): void {
    this.stmtInsertIncident.run({
      agent_run_id: incident.agentRunId,
      company_session_id: incident.companySessionId,
      incident_kind: incident.incidentKind,
      from_state: incident.fromState,
      attempted_to_state: incident.attemptedToState,
      detail: incident.detail,
      diagnostic_json: incident.diagnosticJson ?? null,
      recovery_action: incident.recoveryAction ?? null,
      recovery_outcome: incident.recoveryOutcome ?? null,
      detected_at: msToIso(incident.detectedAtMs),
    });
  }

  resolveIncident(incidentId: number, resolvedAtMs: number): void {
    this.stmtResolveIncident.run({
      id: incidentId,
      resolved_at: msToIso(resolvedAtMs),
    });
  }

  listRecentIncidents(sessionId: number, limit: number): IncidentQueryRow[] {
    // Cast: better-sqlite3's typed signature only accepts a single
    // bound-params argument; we use positional ? markers + variadic.
    const stmt = this.stmtListIncidents as unknown as {
      all(a: number, b: number): IncidentRow[];
    };
    const rows = stmt.all(sessionId, limit);
    return rows.map((r): IncidentQueryRow => ({
      id: r.id,
      agentRunId: r.agent_run_id,
      companySessionId: r.company_session_id,
      incidentKind: r.incident_kind,
      fromState: (r.from_state as SupervisionState | null) ?? null,
      attemptedToState: (r.attempted_to_state as SupervisionState | null) ?? null,
      detail: r.detail,
      diagnosticJson: r.diagnostic_json,
      recoveryAction: r.recovery_action,
      recoveryOutcome:
        (r.recovery_outcome as 'success' | 'failed' | 'queued' | null) ?? null,
      detectedAtMs: isoToMs(r.detected_at),
      resolvedAtMs: r.resolved_at ? isoToMs(r.resolved_at) : null,
    }));
  }

  /** Close the DB handle. Called from supervisor.stop() in production. */
  close(): void {
    try {
      this.db.close();
    } catch {
      /* best-effort */
    }
  }

  private rowToRecord = (row: SupervisionRow): AgentSupervisionRecord => ({
    agentRunId: row.agent_run_id,
    companySessionId: row.company_session_id,
    role: row.role,
    state: row.supervision_state as SupervisionState,
    enteredAt: isoToMs(row.state_entered_at),
    lastHeartbeatAt: isoToMs(row.last_heartbeat_at),
    currentToolUseId: row.current_tool_use_id,
    currentToolName: row.current_tool_name,
    stateTimeoutMsOverride: row.state_timeout_ms_override,
    recoveryAttempts: row.recovery_attempts,
    incidentCount: row.incident_count,
  });
}
