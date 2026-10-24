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
import type { SessionId } from '@mcp/session-storage';

const MAX_WORKFLOWS_PER_SESSION = 12;

function ttlMs(): number {
  return 6 * 60 * 60_000;
}

function leaseMs(): number {
  return 120_000;
}

const bySession = new Map<SessionId, Map<string, WorkflowRecord>>();
const inFlight = new Set<string>();
const leaseTokens = new Map<string, string>();
const leaseGuards = new Map<string, OrchestrationLeaseGuard>();

export interface WorkflowCheckpointStore {
  saveOrchestrationCheckpoint(input: {
    sessionId: SessionId;
    kind: 'workflow';
    scopeId: string;
    privacyClass: 'session_private_redacted';
    payloadJson: string;
    expiresAt: string;
    leaseToken?: string;
  }): Promise<boolean>;
  loadOrchestrationCheckpoint(
    sessionId: SessionId,
    kind: 'workflow',
    scopeId: string,
  ): Promise<{ payload_json: string } | null>;
  listOrchestrationCheckpoints(
    sessionId: SessionId,
    kind: 'workflow',
    limit?: number,
  ): Promise<Array<{ scope_id: string; payload_json: string }>>;
  removeOrchestrationCheckpoint(
    sessionId: SessionId,
    kind: 'workflow',
    scopeId: string,
    leaseToken?: string,
  ): Promise<void>;
  tryAcquireOrchestrationCheckpoint(
    sessionId: SessionId,
    kind: 'workflow',
    scopeId: string,
    leaseMs?: number,
  ): Promise<string | null>;
  releaseOrchestrationCheckpoint(
    sessionId: SessionId,
    kind: 'workflow',
    scopeId: string,
    leaseToken: string,
  ): Promise<void>;
  renewOrchestrationCheckpoint(
    sessionId: SessionId,
    kind: 'workflow',
    scopeId: string,
    leaseToken: string,
    leaseMs?: number,
  ): Promise<boolean>;
}

function parseRecord(
  payloadJson: string,
  sessionId: SessionId,
  workflowId?: string,
): WorkflowRecord | undefined {
  try {
    const record = JSON.parse(payloadJson) as WorkflowRecord;
    if (!record || typeof record !== 'object'
      || typeof record.id !== 'string'
      || (workflowId !== undefined && record.id !== workflowId)
      || record.sessionId !== sessionId
      || record.runtimeGeneration !== undefined && !['legacy_ts'].includes(record.runtimeGeneration)
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

async function persist(
  store: WorkflowCheckpointStore | undefined,
  sessionId: SessionId,
  record: WorkflowRecord,
): Promise<boolean> {
  if (!store || typeof store.saveOrchestrationCheckpoint !== 'function') return true;
  const leaseToken = leaseTokens.get(`${sessionId}:${record.id}`);
  const sanitized = sanitizeCheckpointValue(record);
  try {
    return await store.saveOrchestrationCheckpoint({
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

function sweep(sessionId: SessionId): void {
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

export async function saveWorkflow(
  sessionId: SessionId,
  record: WorkflowRecord,
  store?: WorkflowCheckpointStore,
): Promise<boolean> {
  let records = bySession.get(sessionId);
  if (!records) {
    records = new Map();
    bySession.set(sessionId, records);
  }
  record.updatedAt = Date.now();
  records.set(record.id, record);
  const persisted = await persist(store, sessionId, record);
  sweep(sessionId);
  return persisted;
}

export async function getWorkflow(
  sessionId: SessionId,
  workflowId: string,
  store?: WorkflowCheckpointStore,
): Promise<WorkflowRecord | undefined> {
  sweep(sessionId);
  const cached = bySession.get(sessionId)?.get(workflowId);
  if (cached) return cached;
  const checkpoint = store
    ? await store.loadOrchestrationCheckpoint(
        sessionId,
        'workflow',
        workflowId,
      )
    : null;
  const restored = checkpoint
    ? parseRecord(checkpoint.payload_json, sessionId, workflowId)
    : undefined;
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
export async function reloadWorkflowUnderLease(
  sessionId: SessionId,
  workflowId: string,
  store?: WorkflowCheckpointStore,
): Promise<WorkflowRecord | undefined> {
  await assertWorkflowRunLease(sessionId, workflowId, store);
  const cached = bySession.get(sessionId)?.get(workflowId);
  const leaseToken = leaseTokens.get(`${sessionId}:${workflowId}`);
  const restored = store
    ? store
        .loadOrchestrationCheckpoint(
          sessionId,
          'workflow',
          workflowId,
        )
        .then((checkpoint) =>
          checkpoint
            ? parseRecord(
                checkpoint.payload_json,
                sessionId,
                workflowId,
              )
            : undefined,
        )
    : cached
      ? parseRecord(JSON.stringify(cached), sessionId, workflowId)
      : undefined;
  const resolved = await restored;
  if (!resolved) return undefined;
  let records = bySession.get(sessionId);
  if (!records) {
    records = new Map();
    bySession.set(sessionId, records);
  }
  records.set(workflowId, resolved);
  return resolved;
}

export async function listWorkflows(
  sessionId: SessionId,
  store?: WorkflowCheckpointStore,
): Promise<WorkflowRecord[]> {
  sweep(sessionId);
  if (store) {
    let records = bySession.get(sessionId);
    if (!records) {
      records = new Map();
      bySession.set(sessionId, records);
    }
    for (const checkpoint of await store.listOrchestrationCheckpoints(
      sessionId,
      'workflow',
      MAX_WORKFLOWS_PER_SESSION,
    )) {
      if (records.has(checkpoint.scope_id)) continue;
      const restored = parseRecord(
        checkpoint.payload_json,
        sessionId,
        checkpoint.scope_id,
      );
      if (restored) records.set(restored.id, restored);
    }
  }
  return Array.from(bySession.get(sessionId)?.values() ?? [])
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function clearWorkflows(
  sessionId: SessionId,
  store?: WorkflowCheckpointStore,
): Promise<void> {
  bySession.delete(sessionId);
  if (store) {
    for (const checkpoint of await store.listOrchestrationCheckpoints(
      sessionId,
      'workflow',
      MAX_WORKFLOWS_PER_SESSION,
    )) {
      await store.removeOrchestrationCheckpoint(
        sessionId,
        'workflow',
        checkpoint.scope_id,
      );
    }
  }
}

/** Per-workflow in-flight lock — concurrent resume calls can't double-run. */
export async function tryAcquireWorkflowRun(
  sessionId: SessionId,
  workflowId: string,
  store?: WorkflowCheckpointStore,
): Promise<boolean> {
  const key = `${sessionId}:${workflowId}`;
  if (inFlight.has(key)) return false;
  const duration = leaseMs();
  const leaseToken = store
    ? await store.tryAcquireOrchestrationCheckpoint(
        sessionId,
        'workflow',
        workflowId,
        duration,
      )
    : undefined;
  if (store && !leaseToken) return false;
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
export async function assertWorkflowRunLease(
  sessionId: SessionId,
  workflowId: string,
  store?: WorkflowCheckpointStore,
): Promise<void> {
  if (!store || typeof store.renewOrchestrationCheckpoint !== 'function') return;
  const guard = leaseGuards.get(`${sessionId}:${workflowId}`);
  if (!guard) {
    throw new Error(`workflow '${workflowId}' executor lease was fenced or expired`);
  }
  await guard.assertOwned();
}

/** Keep a short lease alive while a wave is inside provider/tool execution. */
export function startWorkflowRunLeaseKeepalive(
  sessionId: SessionId,
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
  sessionId: SessionId,
  workflowId: string,
): boolean {
  return leaseGuards.get(`${sessionId}:${workflowId}`)?.isRunning() ?? false;
}

export async function releaseWorkflowRun(
  sessionId: SessionId,
  workflowId: string,
  store?: WorkflowCheckpointStore,
): Promise<void> {
  const key = `${sessionId}:${workflowId}`;
  inFlight.delete(key);
  leaseGuards.get(key)?.stop();
  leaseGuards.delete(key);
  const leaseToken = leaseTokens.get(key);
  leaseTokens.delete(key);
  if (store && leaseToken) {
    await store.releaseOrchestrationCheckpoint(
      sessionId,
      'workflow',
      workflowId,
      leaseToken,
    );
  }
}
