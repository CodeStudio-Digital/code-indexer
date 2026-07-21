/**
 * workflow-registry — in-memory, session-keyed retention of workflow runs so
 * `workflow({resume_workflow_id})` can retry failed/skipped steps and the
 * dashboard/read paths can inspect recent runs.
 *
 * Same module-global-per-realm pattern (and rationale) as
 * subagent-resume-registry: resuming is only meaningful while the parent
 * session process is alive; after a restart the durable evidence is the
 * tool_result text persisted in the transcript.
 */
import type { WorkflowRecord } from './workflow-types.js';

const MAX_WORKFLOWS_PER_SESSION = 12;

function ttlMs(): number {
  return Number(process.env.CODER_WORKFLOW_TTL_MS ?? 6 * 60 * 60_000) || 6 * 60 * 60_000;
}

const bySession = new Map<number, Map<string, WorkflowRecord>>();
const inFlight = new Set<string>();

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

export function saveWorkflow(sessionId: number, record: WorkflowRecord): void {
  let records = bySession.get(sessionId);
  if (!records) {
    records = new Map();
    bySession.set(sessionId, records);
  }
  record.updatedAt = Date.now();
  records.set(record.id, record);
  sweep(sessionId);
}

export function getWorkflow(sessionId: number, workflowId: string): WorkflowRecord | undefined {
  sweep(sessionId);
  return bySession.get(sessionId)?.get(workflowId);
}

export function listWorkflows(sessionId: number): WorkflowRecord[] {
  sweep(sessionId);
  return Array.from(bySession.get(sessionId)?.values() ?? [])
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

export function clearWorkflows(sessionId: number): void {
  bySession.delete(sessionId);
}

/** Per-workflow in-flight lock — concurrent resume calls can't double-run. */
export function tryAcquireWorkflowRun(sessionId: number, workflowId: string): boolean {
  const key = `${sessionId}:${workflowId}`;
  if (inFlight.has(key)) return false;
  inFlight.add(key);
  return true;
}

export function releaseWorkflowRun(sessionId: number, workflowId: string): void {
  inFlight.delete(`${sessionId}:${workflowId}`);
}
