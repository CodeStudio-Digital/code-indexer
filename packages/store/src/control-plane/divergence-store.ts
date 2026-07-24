import type DatabaseConstructor from 'better-sqlite3';
import type {
  AgentRunId,
  SessionCommandId,
  SessionId,
} from '@mcp/agent-runtime-contracts';
import { stableControlPlaneJson } from './codec.js';
import type { StateDivergence } from './run-state-comparator.js';

type DB = InstanceType<typeof DatabaseConstructor>;

export interface DivergenceContext {
  sessionId: SessionId;
  legacySessionId?: number;
  commandId?: SessionCommandId;
  agentRunId?: AgentRunId;
}

export interface DivergenceRecord {
  divergenceId: string;
  sessionId: SessionId;
  legacySessionId?: number;
  commandId?: SessionCommandId;
  agentRunId?: AgentRunId;
  kind: string;
  legacyState: Record<string, unknown>;
  controlPlaneState: Record<string, unknown>;
  detail?: string;
  detectedAt: string;
}

interface DivergenceRow {
  divergence_id: string;
  session_id: string;
  legacy_session_id: number | null;
  command_id: string | null;
  agent_run_id: string | null;
  kind: string;
  legacy_state_json: string;
  control_plane_state_json: string;
  detail: string | null;
  detected_at: string;
}

function hydrate(row: DivergenceRow): DivergenceRecord {
  return {
    divergenceId: row.divergence_id,
    sessionId: row.session_id as SessionId,
    legacySessionId: row.legacy_session_id ?? undefined,
    commandId: row.command_id ? row.command_id as SessionCommandId : undefined,
    agentRunId: row.agent_run_id ? row.agent_run_id as AgentRunId : undefined,
    kind: row.kind,
    legacyState: JSON.parse(row.legacy_state_json) as Record<string, unknown>,
    controlPlaneState: JSON.parse(row.control_plane_state_json) as Record<string, unknown>,
    detail: row.detail ?? undefined,
    detectedAt: row.detected_at,
  };
}

/**
 * Audit sink for the shadow projection comparator (Fase 1D). Rows are
 * intentionally written even when the referenced control-plane entity is
 * absent — a "missing command/run" divergence is precisely the case where
 * the FK would not resolve, so the table carries no FK on those columns.
 */
export class ControlPlaneDivergenceStore {
  constructor(private readonly db: DB) {}

  /**
   * Records divergences with deterministic ids (`div:<entity>:<kind>`) so
   * re-detection of the same divergence is a no-op rather than spam.
   * Returns how many rows were newly inserted.
   */
  recordMany(
    context: DivergenceContext,
    divergences: StateDivergence[],
    detectedAt = new Date().toISOString(),
  ): number {
    let inserted = 0;
    const stmt = this.db.prepare(`
      INSERT OR IGNORE INTO control_plane_divergences (
        divergence_id, session_id, legacy_session_id, command_id, agent_run_id,
        kind, legacy_state_json, control_plane_state_json, detail, detected_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const divergence of divergences) {
      const entity = context.agentRunId ?? context.commandId ?? context.sessionId;
      const result = stmt.run(
        `div:${entity}:${divergence.kind}`,
        context.sessionId,
        context.legacySessionId ?? null,
        context.commandId ?? null,
        context.agentRunId ?? null,
        divergence.kind,
        stableControlPlaneJson(divergence.legacyState),
        stableControlPlaneJson(divergence.controlPlaneState),
        divergence.detail,
        detectedAt,
      );
      inserted += result.changes;
    }
    return inserted;
  }

  list(sessionId?: string, limit = 100): DivergenceRecord[] {
    const safeLimit = Math.max(1, Math.min(10_000, Math.floor(limit)));
    const rows = sessionId
      ? this.db.prepare(`
          SELECT * FROM control_plane_divergences
          WHERE session_id = ? ORDER BY detected_at DESC LIMIT ?
        `).all(sessionId, safeLimit) as DivergenceRow[]
      : this.db.prepare(`
          SELECT * FROM control_plane_divergences
          ORDER BY detected_at DESC LIMIT ?
        `).all(safeLimit) as DivergenceRow[];
    return rows.map(hydrate);
  }

  count(sessionId?: string): number {
    const row = sessionId
      ? this.db.prepare('SELECT COUNT(*) AS count FROM control_plane_divergences WHERE session_id = ?').get(sessionId) as { count: number }
      : this.db.prepare('SELECT COUNT(*) AS count FROM control_plane_divergences').get() as { count: number };
    return row.count;
  }
}
