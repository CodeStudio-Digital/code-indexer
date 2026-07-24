/**
 * workflow-registry — memory cache backed by a bounded, redacted private
 * session checkpoint so
 * `workflow({resume_workflow_id})` can retry failed/skipped steps and the
 * dashboard/read paths can inspect recent runs.
 *
 * Completed steps are authoritative in the checkpoint: recreating an executor
 * can only dispatch pending/retried steps and never silently relaunches them.
 */
import type { WorkflowRecord } from './workflow-types.js';
import { sanitizeCheckpointValue } from '../orchestration-checkpoint-redaction.js';
import {
  createOrchestrationLeaseGuard,
  type OrchestrationLeaseGuard,
} from '../orchestration-lease-guard.js';

const MAX_WORKFLOWS_PER_SESSION = 12;

function ttlMs(): number {
  return Number(process.env.CODER_WORKFLOW_TTL_MS ?? 6 * 60 * 60_000) || 6 * 60 * 60_000;
}

function leaseMs(): number {
  const configured = Number(process.env.CODER_ORCHESTRATION_LEASE_MS ?? 120_000);
  return Number.isFinite(configured) && configured >= 60_000
    ? Math.floor(configured)
    : 120_000;
}

const bySession = new Map<number, Map<string, WorkflowRecord>>();
const inFlight = new Set<string>();
const leaseTokens = new Map<string, string>();
const leaseGuards = new Map<string, OrchestrationLeaseGuard>();
const checkpointEnforced = (): boolean => process.env.CODER_AGENT_RUN_STORE_ENFORCE === '1';

export interface WorkflowCheckpointStore {
  saveOrchestrationCheckpoint(input: {
    sessionId: number;
    kind: 'workflow';
    scopeId: string;
    privacyClass: 'session_private_redacted';
    payloadJson: string;
    expiresAt: string;
    leaseToken?: string;
  }): boolean;
  loadOrchestrationCheckpoint(
    sessionId: number,
    kind: 'workflow',
    scopeId: string,
  ): { payloadJson: string } | null;
  listOrchestrationCheckpoints(
    sessionId: number,
    kind: 'workflow',
    limit?: number,
  ): Array<{ scopeId: string; payloadJson: string }>;
  removeOrchestrationCheckpoint(
    sessionId: number,
    kind: 'workflow',
    scopeId: string,
    leaseToken?: string,
  ): void;
  tryAcquireOrchestrationCheckpoint(
    sessionId: number,
    kind: 'workflow',
    scopeId: string,
    leaseMs?: number,
  ): string | null;
  releaseOrchestrationCheckpoint(
    sessionId: number,
    kind: 'workflow',
    scopeId: string,
    leaseToken: string,
  ): void;
  renewOrchestrationCheckpoint(
    sessionId: number,
    kind: 'workflow',
    scopeId: string,
    leaseToken: string,
    leaseMs?: number,
  ): boolean;
}

function parseRecord(payloadJson: string, sessionId: number, workflowId?: string): WorkflowRecord | undefined {
  try {
    const record = JSON.parse(payloadJson) as WorkflowRecord;
    if (!record || typeof record !== 'object'
      || typeof record.id !== 'string'
      || (workflowId !== undefined && record.id !== workflowId)
      || record.sessionId !== sessionId
      || !Array.isArray(record.steps)
      || !record.steps.every((step) =>
        step && typeof step.id === 'string' && typeof step.prompt === 'string'
        && typeof step.status === 'string')) {
      return undefined;
    }
    return record;
  } catch {
    return undefined;
  }
}

function persist(store: WorkflowCheckpointStore | undefined, sessionId: number, record: WorkflowRecord): boolean {
  if (!store || typeof store.saveOrchestrationCheckpoint !== 'function') return true;
  const leaseToken = leaseTokens.get(`${sessionId}:${record.id}`);
  if (leaseToken?.startsWith('compat:')) return !checkpointEnforced();
  const sanitized = sanitizeCheckpointValue(record);
  try {
    return store.saveOrchestrationCheckpoint({
      sessionId,
      kind: 'workflow',
      scopeId: record.id,
      privacyClass: 'session_private_redacted',
      payloadJson: JSON.stringify(sanitized),
      expiresAt: new Date(Date.now() + ttlMs()).toISOString(),
      leaseToken,
    });
  } catch {
    // The memory cache remains authoritative for this process when a bounded
    // private checkpoint is unavailable/oversized.
    return false;
  }
}

function sweep(sessionId: number): void {
  const records = bySession.get(sessionId);
  if (!records) return;
  const now = Date.now();
  const ttl = ttlMs();
  for (const [id, record] of records) {
    if (now - record.updatedAt > ttl) records.delete(id);
  }
  while (records.size > MAX_WORKFLOWS_PER_SESSION) {
    let oldest: WorkflowRecord | null = null;
    for (const record of records.values()) {
      if (!oldest || record.updatedAt < oldest.updatedAt) oldest = record;
    }
    if (!oldest) break;
    records.delete(oldest.id);
  }
  if (records.size === 0) bySession.delete(sessionId);
}

export function saveWorkflow(
  sessionId: number,
  record: WorkflowRecord,
  store?: WorkflowCheckpointStore,
): boolean {
  let records = bySession.get(sessionId);
  if (!records) {
    records = new Map();
    bySession.set(sessionId, records);
  }
  record.updatedAt = Date.now();
  records.set(record.id, record);
  const persisted = persist(store, sessionId, record);
  sweep(sessionId);
  return persisted;
}

export function getWorkflow(
  sessionId: number,
  workflowId: string,
  store?: WorkflowCheckpointStore,
): WorkflowRecord | undefined {
  sweep(sessionId);
  const cached = bySession.get(sessionId)?.get(workflowId);
  if (cached) return cached;
  const row = store?.loadOrchestrationCheckpoint(sessionId, 'workflow', workflowId);
  const restored = row ? parseRecord(row.payloadJson, sessionId, workflowId) : undefined;
  if (!restored) return undefined;
  let records = bySession.get(sessionId);
  if (!records) {
    records = new Map();
    bySession.set(sessionId, records);
  }
  records.set(restored.id, restored);
  return restored;
}

/**
 * Re-read the authoritative checkpoint only after this executor owns its
 * lease. The ordinary getter is cache-first for dashboard/read paths; an
 * executor must never continue with the object it observed before the CAS,
 * because another process may have committed between that read and acquire.
 */
export function reloadWorkflowUnderLease(
  sessionId: number,
  workflowId: string,
  store?: WorkflowCheckpointStore,
): WorkflowRecord | undefined {
  assertWorkflowRunLease(sessionId, workflowId, store);
  const cached = bySession.get(sessionId)?.get(workflowId);
  const leaseToken = leaseTokens.get(`${sessionId}:${workflowId}`);
  const restored = store && !leaseToken?.startsWith('compat:')
    ? (() => {
        const row = store.loadOrchestrationCheckpoint(sessionId, 'workflow', workflowId);
        return row ? parseRecord(row.payloadJson, sessionId, workflowId) : undefined;
      })()
    : cached
      ? parseRecord(JSON.stringify(cached), sessionId, workflowId)
      : undefined;
  if (!restored) return undefined;
  let records = bySession.get(sessionId);
  if (!records) {
    records = new Map();
    bySession.set(sessionId, records);
  }
  records.set(workflowId, restored);
  return restored;
}

export function listWorkflows(sessionId: number, store?: WorkflowCheckpointStore): WorkflowRecord[] {
  sweep(sessionId);
  if (store) {
    let records = bySession.get(sessionId);
    if (!records) {
      records = new Map();
      bySession.set(sessionId, records);
    }
    for (const row of store.listOrchestrationCheckpoints(sessionId, 'workflow', MAX_WORKFLOWS_PER_SESSION)) {
      if (records.has(row.scopeId)) continue;
      const restored = parseRecord(row.payloadJson, sessionId, row.scopeId);
      if (restored) records.set(restored.id, restored);
    }
  }
  return Array.from(bySession.get(sessionId)?.values() ?? [])
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

export function clearWorkflows(sessionId: number, store?: WorkflowCheckpointStore): void {
  bySession.delete(sessionId);
  if (store) {
    for (const row of store.listOrchestrationCheckpoints(sessionId, 'workflow', MAX_WORKFLOWS_PER_SESSION)) {
      store.removeOrchestrationCheckpoint(sessionId, 'workflow', row.scopeId);
    }
  }
}

/** Per-workflow in-flight lock — concurrent resume calls can't double-run. */
export function tryAcquireWorkflowRun(
  sessionId: number,
  workflowId: string,
  store?: WorkflowCheckpointStore,
): boolean {
  const key = `${sessionId}:${workflowId}`;
  if (inFlight.has(key)) return false;
  const duration = leaseMs();
  const leaseToken = store?.tryAcquireOrchestrationCheckpoint(
    sessionId,
    'workflow',
    workflowId,
    duration,
  );
  if (store && !leaseToken) return false;
  if (leaseToken?.startsWith('compat:') && checkpointEnforced()) {
    throw new Error(`workflow '${workflowId}' requires migration 259 while AgentRun enforcement is enabled`);
  }
  inFlight.add(key);
  if (leaseToken) {
    leaseTokens.set(key, leaseToken);
    leaseGuards.set(key, createOrchestrationLeaseGuard({
      label: `workflow '${workflowId}'`,
      leaseMs: duration,
      renew: () => typeof store?.renewOrchestrationCheckpoint !== 'function'
        || store.renewOrchestrationCheckpoint(
          sessionId,
          'workflow',
          workflowId,
          leaseToken,
          duration,
        ),
    }));
  }
  return true;
}

/** Renew/verify the operation token immediately before dispatch or commit. */
export function assertWorkflowRunLease(
  sessionId: number,
  workflowId: string,
  store?: WorkflowCheckpointStore,
): void {
  if (!store || typeof store.renewOrchestrationCheckpoint !== 'function') return;
  const guard = leaseGuards.get(`${sessionId}:${workflowId}`);
  if (!guard) {
    throw new Error(`workflow '${workflowId}' executor lease was fenced or expired`);
  }
  guard.assertOwned();
}

/** Keep a short lease alive while a wave is inside provider/tool execution. */
export function startWorkflowRunLeaseKeepalive(
  sessionId: number,
  workflowId: string,
  store?: WorkflowCheckpointStore,
  onLost?: (error: Error) => void,
): () => void {
  if (!store || typeof store.renewOrchestrationCheckpoint !== 'function') return () => {};
  const guard = leaseGuards.get(`${sessionId}:${workflowId}`);
  if (!guard) throw new Error(`workflow '${workflowId}' executor lease was fenced or expired`);
  return guard.start(onLost);
}

export function workflowLeaseKeepaliveActiveForTests(
  sessionId: number,
  workflowId: string,
): boolean {
  return leaseGuards.get(`${sessionId}:${workflowId}`)?.isRunning() ?? false;
}

export function releaseWorkflowRun(
  sessionId: number,
  workflowId: string,
  store?: WorkflowCheckpointStore,
): void {
  const key = `${sessionId}:${workflowId}`;
  inFlight.delete(key);
  leaseGuards.get(key)?.stop();
  leaseGuards.delete(key);
  const leaseToken = leaseTokens.get(key);
  leaseTokens.delete(key);
  if (store && leaseToken) {
    store.releaseOrchestrationCheckpoint(sessionId, 'workflow', workflowId, leaseToken);
  }
}
