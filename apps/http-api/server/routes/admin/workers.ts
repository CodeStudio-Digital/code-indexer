/**
 * Diagnostic endpoints for the Company and coder worker pools.
 *
 * Session-scoped diagnostics are derived from the filesystem bundles. This
 * route deliberately has no SQLite handle, compatibility query or durable
 * global index.
 */
import type { Hono } from 'hono';
import type { AgentRun } from '@mcp/agent-runtime-contracts';
import type { FsSessionStore } from '@mcp/session-storage/fs-store/index.js';
import {
  ControlPlaneFileRepository,
  type ControlPlaneEntityDataMap,
  type ControlPlaneEntityKind,
  type EntityRecord,
} from '@mcp/session-storage';
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
  sessionId: string;
  workerState: string;
  lastTouchedAt: number;
  idleMs: number;
}

interface WorkersResponse {
  company: {
    enabled: boolean;
    reason: string | null;
    workerFile: string | null;
    workers: WorkerRow[];
  };
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

export interface JournalStorageReport {
  available: boolean;
  events: number;
  totalBytes: number;
  runs: JournalStorageByRun[];
}

export interface AgentRunShadowReport {
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

export interface PolicyDivergenceReport {
  available: boolean;
  total: number;
  agreements: number;
  agreementRate: number;
  criticalDivergences: number;
  evaluationOverhead: EvaluationOverhead;
  divergences: PolicyDivergenceRow[];
}

interface PersistedPolicyComparison {
  recordType: 'comparison';
  comparisonId: string;
  capabilityId: string;
  legacyEffect: string;
  shadowEffect: string;
  agreement: boolean;
  divergenceKind?: string | null;
  critical?: boolean | number;
  detail?: string | null;
  comparedAt: string;
  evaluationMs?: number | null;
}

const EMPTY_OVERHEAD: EvaluationOverhead = {
  p50: 0,
  p95: 0,
  p99: 0,
  samples: 0,
};
const TERMINAL_RUN_STATUSES = new Set([
  'completed',
  'failed',
  'aborted',
  'interrupted',
]);

function computeOverhead(samples: number[]): EvaluationOverhead {
  if (samples.length === 0) return EMPTY_OVERHEAD;
  const sorted = [...samples].sort((a, b) => a - b);
  const pick = (percentile: number): number =>
    sorted[
      Math.min(
        sorted.length - 1,
        Math.max(0, Math.ceil((percentile / 100) * sorted.length) - 1),
      )
    ];
  return {
    p50: pick(50),
    p95: pick(95),
    p99: pick(99),
    samples: sorted.length,
  };
}

async function listAll<K extends ControlPlaneEntityKind>(
  repository: ControlPlaneFileRepository,
  kind: K,
): Promise<Array<EntityRecord<ControlPlaneEntityDataMap[K]>>> {
  const records: Array<EntityRecord<ControlPlaneEntityDataMap[K]>> = [];
  let cursor: string | undefined;
  do {
    const page = await repository.list(kind, {
      cursor,
      limit: 1_000,
      order: 'asc',
    });
    records.push(...page.items);
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
  return records;
}

async function visitControlPlaneBundles(
  sessionStore: FsSessionStore,
  visitor: (
    repository: ControlPlaneFileRepository,
    sessionId: string,
  ) => Promise<void>,
): Promise<void> {
  await sessionStore.ensureCatalog();
  // Keep the diagnostic scan bounded to one bundle at a time. It is an
  // infrequent admin read and must not create an I/O burst across projects.
  for (const entry of sessionStore.catalog.list()) {
    await visitor(
      new ControlPlaneFileRepository({
        sessionRoot: entry.location.bundle_path,
      }),
      String(entry.session.id),
    );
  }
}

function eventPayload(
  record: EntityRecord<ControlPlaneEntityDataMap['event']>,
): Record<string, unknown> {
  const payload = record.data.payload;
  return payload && typeof payload === 'object' && !Array.isArray(payload)
    ? payload as Record<string, unknown>
    : {};
}

function eventRunId(
  record: EntityRecord<ControlPlaneEntityDataMap['event']>,
): string | null {
  const relation = record.relations.run;
  if (typeof relation === 'string') return relation;
  const envelope = record.data.envelope;
  if (envelope && typeof envelope === 'object' && !Array.isArray(envelope)) {
    const id = (envelope as Record<string, unknown>).agentRunId;
    if (typeof id === 'string') return id;
  }
  return null;
}

export async function readJournalStorageByRun(
  sessionStore: FsSessionStore,
): Promise<JournalStorageReport> {
  const grouped = new Map<string | null, JournalStorageByRun>();
  let events = 0;
  let totalBytes = 0;
  try {
    await visitControlPlaneBundles(sessionStore, async (repository) => {
      for (const record of await listAll(repository, 'event')) {
        const payloadBytes = Buffer.byteLength(
          JSON.stringify(record.data.payload ?? null),
          'utf8',
        );
        const agentRunId = eventRunId(record);
        const current = grouped.get(agentRunId) ?? {
          agentRunId,
          events: 0,
          payloadBytes: 0,
        };
        current.events += 1;
        current.payloadBytes += payloadBytes;
        grouped.set(agentRunId, current);
        events += 1;
        totalBytes += payloadBytes;
      }
    });
    return {
      available: true,
      events,
      totalBytes,
      runs: [...grouped.values()].sort(
        (left, right) =>
          right.payloadBytes - left.payloadBytes ||
          String(left.agentRunId).localeCompare(String(right.agentRunId)),
      ),
    };
  } catch {
    return { available: false, events: 0, totalBytes: 0, runs: [] };
  }
}

function persistedRun(
  record: EntityRecord<ControlPlaneEntityDataMap['run']>,
): AgentRun | null {
  const run = record.data.run;
  return run && typeof run === 'object' && !Array.isArray(run)
    ? run as unknown as AgentRun
    : null;
}

export async function readAgentRunShadowMetrics(
  sessionStore: FsSessionStore,
): Promise<AgentRunShadowReport> {
  const report: AgentRunShadowReport = {
    available: true,
    childRunsCreated: 0,
    childRunsTerminalized: 0,
    activeChildRuns: 0,
    writeErrors: 0,
  };
  try {
    await visitControlPlaneBundles(sessionStore, async (repository) => {
      const [runs, events] = await Promise.all([
        listAll(repository, 'run'),
        listAll(repository, 'event'),
      ]);
      for (const record of runs) {
        const run = persistedRun(record);
        if (!run?.parentAgentRunId) continue;
        report.childRunsCreated += 1;
        if (TERMINAL_RUN_STATUSES.has(run.status)) {
          report.childRunsTerminalized += 1;
        } else {
          report.activeChildRuns += 1;
        }
      }
      for (const record of events) {
        const payload = eventPayload(record);
        if (
          record.data.eventType === 'control-plane.divergence' &&
          payload.kind === 'agent_run_shadow_write_error'
        ) {
          report.writeErrors += 1;
        }
      }
    });
    return report;
  } catch {
    return {
      available: false,
      childRunsCreated: 0,
      childRunsTerminalized: 0,
      activeChildRuns: 0,
      writeErrors: 0,
    };
  }
}

function policyComparison(
  record: EntityRecord<ControlPlaneEntityDataMap['policyDecision']>,
): PersistedPolicyComparison | null {
  const data = record.data as Record<string, unknown>;
  if (
    data.recordType !== 'comparison' ||
    typeof data.comparisonId !== 'string' ||
    typeof data.capabilityId !== 'string' ||
    typeof data.legacyEffect !== 'string' ||
    typeof data.shadowEffect !== 'string' ||
    typeof data.agreement !== 'boolean' ||
    typeof data.comparedAt !== 'string'
  ) {
    return null;
  }
  return data as unknown as PersistedPolicyComparison;
}

export async function readPolicyDivergences(
  sessionStore: FsSessionStore,
  limit = 100,
): Promise<PolicyDivergenceReport> {
  const safeLimit = Math.max(1, Math.min(1_000, Math.floor(limit)));
  const comparisons: PersistedPolicyComparison[] = [];
  try {
    await visitControlPlaneBundles(sessionStore, async (repository) => {
      for (const record of await listAll(repository, 'policyDecision')) {
        const comparison = policyComparison(record);
        if (comparison) comparisons.push(comparison);
      }
    });
    comparisons.sort(
      (left, right) =>
        Date.parse(right.comparedAt) - Date.parse(left.comparedAt) ||
        right.comparisonId.localeCompare(left.comparisonId),
    );
    const agreements = comparisons.filter(
      (comparison) => comparison.agreement,
    ).length;
    const criticalDivergences = comparisons.filter(
      (comparison) => !comparison.agreement && Boolean(comparison.critical),
    ).length;
    return {
      available: true,
      total: comparisons.length,
      agreements,
      agreementRate:
        comparisons.length > 0 ? agreements / comparisons.length : 1,
      criticalDivergences,
      evaluationOverhead: computeOverhead(
        comparisons
          .map((comparison) => comparison.evaluationMs)
          .filter(
            (sample): sample is number =>
              typeof sample === 'number' && Number.isFinite(sample),
          ),
      ),
      divergences: comparisons
        .filter((comparison) => !comparison.agreement)
        .slice(0, safeLimit)
        .map((comparison) => ({
          comparisonId: comparison.comparisonId,
          capabilityId: comparison.capabilityId,
          legacyEffect: comparison.legacyEffect,
          shadowEffect: comparison.shadowEffect,
          divergenceKind: comparison.divergenceKind ?? null,
          critical: comparison.critical ? 1 : 0,
          detail: comparison.detail ?? null,
          comparedAt: comparison.comparedAt,
        })),
    };
  } catch {
    return {
      available: false,
      total: 0,
      agreements: 0,
      agreementRate: 0,
      criticalDivergences: 0,
      evaluationOverhead: EMPTY_OVERHEAD,
      divergences: [],
    };
  }
}

export function mountWorkersDiagnosticRoute(
  app: Hono,
  deps: { sessionStore: FsSessionStore },
): void {
  app.get('/api/admin/workers/control-plane/storage', async (c) => {
    return c.json(await readJournalStorageByRun(deps.sessionStore));
  });

  app.get('/api/admin/workers/control-plane/policy-divergences', async (c) => {
    const limit = Number(c.req.query('limit') ?? '100');
    return c.json(
      await readPolicyDivergences(
        deps.sessionStore,
        Number.isFinite(limit) ? limit : 100,
      ),
    );
  });

  app.get('/api/admin/workers', async (c) => {
    const company: WorkerRow[] = [];
    const coder: WorkerRow[] = [];

    try {
      company.push(...getWorkerOrchestratorPool().snapshot());
    } catch {
      // Pool not initialized yet.
    }
    try {
      coder.push(...getCoderWorkerPool().snapshot());
    } catch {
      // Pool not initialized yet.
    }

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
        metrics: await readAgentRunShadowMetrics(deps.sessionStore),
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
