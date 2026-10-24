import { createHash } from 'node:crypto';
import type { FsSessionStore } from '@mcp/session-storage/fs-store/index.js';
import type { SessionId } from '@mcp/session-storage';
import type { CoderTask, TasksState } from '@mcp/session-storage/session-state-types.js';
import type { ToolContext } from '../../core/tool.js';
import { uncertainToolOutcomeError } from '../../core/uncertain-tool-outcome.js';
import { createOrchestrationLeaseGuard } from '../orchestration-lease-guard.js';
import type { TaskRunPersist } from './task-run-types.js';

type Store = Pick<FsSessionStore, 'saveOrchestrationCheckpoint' | 'loadOrchestrationCheckpointForAudit'
  | 'tryAcquireOrchestrationCheckpoint' | 'renewOrchestrationCheckpoint' | 'releaseOrchestrationCheckpoint'>;
type Admission = { taskId: string; taskSha: string; reference: string };
type Checkpoint = { version: 1; runtimeGeneration: 'rust_v1'; sessionId: string; admissions: Admission[] };
const KIND = 'execute_tasks', SCOPE = 'native-task-board', LEASE_MS = 120_000;
// This is effect ownership, not a display cache. Age must never authorize a retry.
const EXPIRES = '9999-12-31T23:59:59.999Z';
const referencePattern = /^native-child-journal:(?:[a-f\d-]{36}:){3}[a-f\d-]{36}$/i;
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
    .map(([key, item]) => [key, canonical(item)]));
  return value;
}

export function nativeTaskDefinitionSha(task: CoderTask): string {
  const { status: _status, result: _result, started_at: _start, finished_at: _finish,
    mode_used: _mode, task_run_id: _run, ...definition } = task;
  return createHash('sha256').update(JSON.stringify(canonical(definition))).digest('hex');
}

function parse(payload: string, sessionId: SessionId): Checkpoint {
  if (Buffer.byteLength(payload) > 128 * 1024) throw new Error('Native task checkpoint exceeds its bound');
  const value = JSON.parse(payload) as Checkpoint;
  if (value?.version !== 1 || value.runtimeGeneration !== 'rust_v1' || value.sessionId !== sessionId
    || !Array.isArray(value.admissions) || value.admissions.length > 128
    || !value.admissions.every(a => a && typeof a.taskId === 'string' && a.taskId.length > 0 && a.taskId.length <= 128
      && /^[a-f\d]{64}$/.test(a.taskSha) && typeof a.reference === 'string' && referencePattern.test(a.reference))
    || new Set(value.admissions.map(a => a.taskId)).size !== value.admissions.length
    || new Set(value.admissions.map(a => a.reference)).size !== value.admissions.length) {
    throw new Error('Native task checkpoint is invalid');
  }
  return value;
}

/** Admission references commit before child preparation. Only validated child
 * journals plus physical drain can retire a reference or restore completion.
 * Task-run rows and model-visible summaries never grant permission to retry. */
export async function openNativeTaskCheckpoint(input: {
  store: Store; sessionId: SessionId; context: ToolContext; state: TasksState;
}): Promise<{ context: ToolContext; wrap(persist: TaskRunPersist): TaskRunPersist; close(): Promise<void> }> {
  const { store, sessionId, context, state } = input;
  const tree = context.ports?.agentTree;
  if (!tree?.reconcile || !context.currentToolUseId || !context.updateTaskStatus) {
    throw new Error('Native task execution requires owned reconciliation and task ports');
  }
  const controller = new AbortController();
  const signal = AbortSignal.any([controller.signal, ...(context.signal ? [context.signal] : [])]);
  const unknown = (detail: string): never => {
    context.toolCallLedger?.markOutcomeUnknown('execute_tasks');
    throw uncertainToolOutcomeError(`execute_tasks: ${detail}`);
  };
  const reconcile = async (reference: string) => {
    try { return await tree.reconcile!(reference, { signal }); }
    catch (cause) { signal.throwIfAborted(); return unknown(`${reference}: reconciliation failed`); }
  };
  signal.throwIfAborted();
  if (!await store.loadOrchestrationCheckpointForAudit(sessionId, KIND, SCOPE)) {
    await store.saveOrchestrationCheckpoint({ sessionId, kind: KIND, scopeId: SCOPE,
      privacyClass: 'session_private_redacted', expiresAt: EXPIRES, createOnly: true,
      payloadJson: JSON.stringify({ version: 1, runtimeGeneration: 'rust_v1', sessionId, admissions: [] } satisfies Checkpoint) });
  }
  const token = await store.tryAcquireOrchestrationCheckpoint(sessionId, KIND, SCOPE, LEASE_MS);
  if (!token) throw new Error('Native task checkpoint is owned by another execution or requires recovery');
  const lease = createOrchestrationLeaseGuard({ label: 'Native task', leaseMs: LEASE_MS,
    renew: () => store.renewOrchestrationCheckpoint(sessionId, KIND, SCOPE, token, LEASE_MS) });
  lease.start(error => controller.abort(error));
  let closed = false, serial: Promise<void> = Promise.resolve();
  const close = async () => {
    if (closed) return;
    closed = true; controller.abort(); lease.stop();
    await serial.catch(() => {});
    await store.releaseOrchestrationCheckpoint(sessionId, KIND, SCOPE, token);
  };
  try {
    const row = await store.loadOrchestrationCheckpointForAudit(sessionId, KIND, SCOPE);
    if (!row) return unknown('admission anchor disappeared');
    let checkpoint: Checkpoint;
    try { checkpoint = parse(row.payload_json, sessionId); }
    catch { return unknown('invalid admission checkpoint'); }
    const verified = new Set<string>();
    // Reconcile all previous references, including tasks removed from a new
    // board. Replacing a plan cannot bypass an unresolved workspace effect.
    for (const admission of checkpoint.admissions) {
      signal.throwIfAborted(); await lease.assertOwned();
      const proof = await reconcile(admission.reference);
      if (proof.outcome !== 'terminal') return unknown(admission.reference);
      verified.add(admission.reference);
      const task = state.tasks.find(t => t.id === admission.taskId);
      if (task && nativeTaskDefinitionSha(task) === admission.taskSha && proof.stepStatus === 'completed'
        && (task.status !== 'done' || task.result?.effectOutcome === 'unknown')) {
        // Keep the complete result in its durable child transcript. A compact
        // pointer avoids overflowing the bounded native board with long prose.
        await context.updateTaskStatus(task.id, { status: 'done', mode_used: 'subagent',
          result: { summary: `Recovered confirmed completion. ${admission.reference}`, files_modified: [] } });
      }
    }
    const save = async () => {
      signal.throwIfAborted(); await lease.assertOwned(); signal.throwIfAborted();
      if (!await store.saveOrchestrationCheckpoint({ sessionId, kind: KIND, scopeId: SCOPE,
        privacyClass: 'session_private_redacted', payloadJson: JSON.stringify(checkpoint), expiresAt: EXPIRES, leaseToken: token })) {
        throw new Error('Native task checkpoint publication lost its lease');
      }
    };
    const admit = (args: Parameters<NonNullable<TaskRunPersist['recordTaskAdmitted']>>[0]) => {
      const next = serial.then(async () => {
        signal.throwIfAborted();
        if (!referencePattern.test(args.nativeTranscriptRef)) throw new Error('Invalid native task child reference');
        const prior = checkpoint.admissions.find(a => a.taskId === args.task.id);
        if (prior?.reference === args.nativeTranscriptRef) {
          if (prior.taskSha !== nativeTaskDefinitionSha(args.task)) throw new Error('Native task admission definition changed');
          return;
        }
        if (prior && !verified.has(prior.reference)) {
          const proof = await reconcile(prior.reference);
          if (proof.outcome !== 'terminal') return unknown(prior.reference);
          verified.add(prior.reference);
        }
        if (checkpoint.admissions.some(a => a.reference === args.nativeTranscriptRef)) throw new Error('Native child belongs to another task');
        // Discard only references proven terminal and absent from this board.
        checkpoint.admissions = checkpoint.admissions.filter(a => a.taskId !== args.task.id
          && (state.tasks.some(t => t.id === a.taskId) || !verified.has(a.reference)));
        if (checkpoint.admissions.length >= 128) throw new Error('Native task admission bound exceeded');
        checkpoint.admissions.push({ taskId: args.task.id, taskSha: nativeTaskDefinitionSha(args.task), reference: args.nativeTranscriptRef });
        await save();
      });
      // A failed durable write poisons this owner; later admissions cannot
      // pretend the in-memory candidate was published successfully.
      serial = next.catch(cause => { controller.abort(cause); throw cause; });
      return serial;
    };
    return { context: { ...context, signal }, close,
      wrap: persist => ({ ...persist, recordTaskAdmitted: async args => {
        await admit(args);
        if (!persist.recordTaskAdmitted) throw new Error('Native task projection persistence unavailable');
        await persist.recordTaskAdmitted(args);
      } }),
    };
  } catch (cause) {
    await close(); throw cause;
  }
}
