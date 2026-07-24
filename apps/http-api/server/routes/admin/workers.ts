/**
 * Diagnostic endpoint for the worker pools.
 *
 * `GET /api/admin/workers` returns a snapshot of every spawned
 * worker_thread alongside its lifecycle state. Company and coder runs are
 * both workers-only; failure to resolve either worker is a boot error.
 *
 * Response shape:
 * ```json
 * {
 *   "company": {
 *     "enabled": true,
 *     "workers": [
 *       { "sessionId": 42, "workerState": "running", "lastTouchedAt": …, "idleMs": 1234 }
 *     ]
 *   },
 *   "coder": {
 *     "enabled": false,
 *     "workers": []
 *   },
 *   "node": {
 *     "pid": 12345,
 *     "uptimeSec": 600,
 *     "memMB": 128
 *   }
 * }
 * ```
 *
 * The response is intentionally tiny — purely metadata, no per-event
 * detail. The dashboard doesn't currently consume it; it's for
 * `curl http://localhost:7317/api/admin/workers | jq` during smoke
 * testing.
 */
import type { Hono } from 'hono';
import Database from 'better-sqlite3';
import { loadConfig } from '@mcp/shared/utils/config.js';
import {
  describeWorkerOrchestratorStatus,
  getWorkerOrchestratorPool,
} from '../../../sse/workerPoolSingleton.js';
import {
  describeCoderWorkerStatus,
  getCoderWorkerPool,
} from '../../../sse/coderWorkerPoolSingleton.js';
import {
  coderControlPlaneShadowEnabled,
  coderRuntimeJournalShadowEnabled,
  snapshotCoderControlPlaneShadowMetrics,
  type CoderControlPlaneShadowMetrics,
} from '../../../control-plane-shadow.js';

interface WorkerRow {
  sessionId: number;
  workerState: string;
  lastTouchedAt: number;
  idleMs: number;
}

interface WorkersResponse {
  // Company orchestrator: workers-only architecture, no env gate.
  // `enabled` reflects whether the worker file resolved.
  company: {
    enabled: boolean;
    reason: string | null;
    workerFile: string | null;
    workers: WorkerRow[];
  };
  // Coder runner pool: workers-only, same fail-closed posture as Company.
  coder: {
    enabled: boolean;
    reason: string | null;
    workerFile: string | null;
    workers: WorkerRow[];
  };
  controlPlaneShadow: {
    enabled: boolean;
    journalEnabled: boolean;
    metrics: CoderControlPlaneShadowMetrics;
  };
  agentRunShadow: {
    enabled: boolean;
    metrics: AgentRunShadowReport;
  };
  node: { pid: number; uptimeSec: number; memMB: number };
}

interface JournalStorageByRun {
  agentRunId: string | null;
  events: number;
  payloadBytes: number;
}

interface JournalStorageReport {
  available: boolean;
  events: number;
  totalBytes: number;
  runs: JournalStorageByRun[];
}

let cachedDbPath: string | null = null;

/**
 * On-demand journal storage read (Fase 1 metrics: storage bytes/run).
 * Uses a short-lived READONLY connection — the same precedent as
 * app-studio/data.ts — so it never adds a writer to the central WAL.
 * Degrades to `available: false` on :memory: DBs, missing files, or
 * databases created before migration 251.
 */
function readJournalStorageByRun(): JournalStorageReport {
  const empty: JournalStorageReport = { available: false, events: 0, totalBytes: 0, runs: [] };
  try {
    cachedDbPath ??= loadConfig().dbPath;
    if (cachedDbPath.includes(':memory:')) return empty;
    const db = new Database(cachedDbPath, { readonly: true, fileMustExist: true });
    try {
      const totals = db.prepare(`
        SELECT COUNT(*) AS events, COALESCE(SUM(LENGTH(payload_json)), 0) AS totalBytes
        FROM runtime_events
      `).get() as { events: number; totalBytes: number };
      const runs = db.prepare(`
        SELECT agent_run_id AS agentRunId, COUNT(*) AS events,
          COALESCE(SUM(LENGTH(payload_json)), 0) AS payloadBytes
        FROM runtime_events
        GROUP BY agent_run_id
        ORDER BY payloadBytes DESC
      `).all() as JournalStorageByRun[];
      return { available: true, events: totals.events, totalBytes: totals.totalBytes, runs };
    } finally {
      db.close();
    }
  } catch {
    return empty;
  }
}

interface AgentRunShadowReport {
  available: boolean;
  childRunsCreated: number;
  childRunsTerminalized: number;
  activeChildRuns: number;
  writeErrors: number;
}

interface PolicyDivergenceRow {
  comparisonId: string;
  capabilityId: string;
  legacyEffect: string;
  shadowEffect: string;
  divergenceKind: string | null;
  critical: number;
  detail: string | null;
  comparedAt: string;
}

interface EvaluationOverhead {
  p50: number;
  p95: number;
  p99: number;
  samples: number;
}

interface PolicyDivergenceReport {
  available: boolean;
  total: number;
  agreements: number;
  agreementRate: number;
  criticalDivergences: number;
  evaluationOverhead: EvaluationOverhead;
  divergences: PolicyDivergenceRow[];
}

const EMPTY_OVERHEAD: EvaluationOverhead = { p50: 0, p95: 0, p99: 0, samples: 0 };

/** Nearest-rank percentiles over the durable evaluation_ms samples. */
function computeOverhead(samples: number[]): EvaluationOverhead {
  if (samples.length === 0) return EMPTY_OVERHEAD;
  const sorted = [...samples].sort((a, b) => a - b);
  const pick = (p: number): number =>
    sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))];
  return { p50: pick(50), p95: pick(95), p99: pick(99), samples: sorted.length };
}

/**
 * Reads evaluation_ms samples for the overhead percentiles. Isolated in its
 * own try/catch: a database created before migration 256 has no
 * `evaluation_ms` column, and that must NOT mark the whole report
 * unavailable — it degrades to zeroed percentiles instead.
 */
function readEvaluationOverhead(db: InstanceType<typeof Database>): EvaluationOverhead {
  try {
    const rows = db.prepare(`
      SELECT evaluation_ms AS ms FROM policy_decision_comparisons
      WHERE evaluation_ms IS NOT NULL
      ORDER BY compared_at DESC
      LIMIT 2000
    `).all() as Array<{ ms: number }>;
    return computeOverhead(rows.map((r) => r.ms));
  } catch {
    return EMPTY_OVERHEAD;
  }
}

/** Durable Fase-3 child-run counters read from the central SQLite DB. */
function readAgentRunShadowMetrics(): AgentRunShadowReport {
  const empty: AgentRunShadowReport = {
    available: false,
    childRunsCreated: 0,
    childRunsTerminalized: 0,
    activeChildRuns: 0,
    writeErrors: 0,
  };
  try {
    cachedDbPath ??= loadConfig().dbPath;
    if (cachedDbPath.includes(':memory:')) return empty;
    const db = new Database(cachedDbPath, { readonly: true, fileMustExist: true });
    try {
      const runs = db.prepare(`
        SELECT
          COUNT(*) AS childRunsCreated,
          COALESCE(SUM(CASE WHEN status IN ('completed', 'failed', 'aborted', 'interrupted') THEN 1 ELSE 0 END), 0)
            AS childRunsTerminalized,
          COALESCE(SUM(CASE WHEN status NOT IN ('completed', 'failed', 'aborted', 'interrupted') THEN 1 ELSE 0 END), 0)
            AS activeChildRuns
        FROM agent_runs
        WHERE role = 'subagent' AND parent_agent_run_id IS NOT NULL
      `).get() as Omit<AgentRunShadowReport, 'available' | 'writeErrors'>;
      const errors = db.prepare(`
        SELECT COUNT(*) AS count FROM control_plane_divergences
        WHERE kind = 'agent_run_shadow_write_error'
      `).get() as { count: number };
      return { available: true, ...runs, writeErrors: errors.count };
    } finally {
      db.close();
    }
  } catch {
    return empty;
  }
}

/**
 * On-demand Policy Engine shadow comparison read (Fase 2). Same short-lived
 * READONLY connection as the storage endpoint. Degrades to `available: false`
 * on :memory: DBs, missing files, or databases created before migration 255.
 */
function readPolicyDivergences(limit = 100): PolicyDivergenceReport {
  const empty: PolicyDivergenceReport = {
    available: false, total: 0, agreements: 0, agreementRate: 0, criticalDivergences: 0,
    evaluationOverhead: EMPTY_OVERHEAD, divergences: [],
  };
  const safeLimit = Math.max(1, Math.min(1000, Math.floor(limit)));
  try {
    cachedDbPath ??= loadConfig().dbPath;
    if (cachedDbPath.includes(':memory:')) return empty;
    const db = new Database(cachedDbPath, { readonly: true, fileMustExist: true });
    try {
      const totals = db.prepare(`
        SELECT COUNT(*) AS total,
          COALESCE(SUM(agreement), 0) AS agreements,
          COALESCE(SUM(critical), 0) AS critical
        FROM policy_decision_comparisons
      `).get() as { total: number; agreements: number; critical: number };
      const divergences = db.prepare(`
        SELECT comparison_id AS comparisonId, capability_id AS capabilityId,
          legacy_effect AS legacyEffect, shadow_effect AS shadowEffect,
          divergence_kind AS divergenceKind, critical, detail, compared_at AS comparedAt
        FROM policy_decision_comparisons
        WHERE agreement = 0
        ORDER BY compared_at DESC
        LIMIT ?
      `).all(safeLimit) as PolicyDivergenceRow[];
      return {
        available: true,
        total: totals.total,
        agreements: totals.agreements,
        agreementRate: totals.total > 0 ? totals.agreements / totals.total : 1,
        criticalDivergences: totals.critical,
        evaluationOverhead: readEvaluationOverhead(db),
        divergences,
      };
    } finally {
      db.close();
    }
  } catch {
    return empty;
  }
}

export function mountWorkersDiagnosticRoute(app: Hono): void {
  app.get('/api/admin/workers/control-plane/storage', (c) => {
    return c.json(readJournalStorageByRun());
  });

  app.get('/api/admin/workers/control-plane/policy-divergences', (c) => {
    const limit = Number(c.req.query('limit') ?? '100');
    return c.json(readPolicyDivergences(Number.isFinite(limit) ? limit : 100));
  });

  app.get('/api/admin/workers', (c) => {
    const company: WorkerRow[] = [];
    const coder: WorkerRow[] = [];

    // Company pool: always available when the worker file resolves.
    // The server refuses to boot otherwise (see startServer).
    try {
      company.push(...getWorkerOrchestratorPool().snapshot());
    } catch { /* pool not initialized yet */ }
    try {
      coder.push(...getCoderWorkerPool().snapshot());
    } catch { /* pool not initialized yet */ }

    const mem = process.memoryUsage();
    const companyStatus = describeWorkerOrchestratorStatus();
    const coderStatus = describeCoderWorkerStatus();
    const body: WorkersResponse = {
      company: {
        enabled: companyStatus.enabled,
        reason: companyStatus.reason,
        workerFile: companyStatus.resolved?.file ?? null,
        workers: company,
      },
      coder: {
        enabled: coderStatus.enabled,
        reason: coderStatus.reason,
        workerFile: coderStatus.resolved?.file ?? null,
        workers: coder,
      },
      controlPlaneShadow: {
        enabled: coderControlPlaneShadowEnabled(),
        journalEnabled: coderRuntimeJournalShadowEnabled(),
        metrics: snapshotCoderControlPlaneShadowMetrics(),
      },
      agentRunShadow: {
        enabled: process.env.CODER_AGENT_RUN_STORE_SHADOW === '1',
        metrics: readAgentRunShadowMetrics(),
      },
      node: {
        pid: process.pid,
        uptimeSec: Math.round(process.uptime()),
        memMB: Math.round(mem.rss / (1024 * 1024)),
      },
    };
    return c.json(body);
  });
}
