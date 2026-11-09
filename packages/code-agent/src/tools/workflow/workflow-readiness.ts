import type { WorkflowRecord, WorkflowStepState } from './workflow-types.js';

export function readyWorkflowSteps(record: WorkflowRecord): WorkflowStepState[] {
  return record.steps.filter(step => step.status === 'pending' && step.dependsOn.every(id => {
    const dep = record.steps.find(row => row.id === id);
    if (dep?.integration?.state === 'pending') return false;
    return dep?.status === 'completed' || (dep?.status === 'partial' && step.acceptPartial?.includes(id));
  }));
}

function overlappingWriters(left: WorkflowStepState, right: WorkflowStepState): boolean {
  if (![left, right].every(step => ['implement', 'full'].includes(step.profileId))) return false;
  if (!left.files?.length || !right.files?.length) return true;
  const normalize = (path: string) => path.replaceAll('\\', '/').toLowerCase().replace(/\/+$/, '');
  return left.files.some(a => right.files!.some(b => {
    const x = normalize(a), y = normalize(b);
    return /[*?]/.test(x + y) || x === y || x.startsWith(y + '/') || y.startsWith(x + '/');
  }));
}

/** Dispatch a successor as soon as its own prerequisites finish. A slow sibling
 * must not create a global wave barrier. Every promise is joined on failure. */
export async function runReadyWorkflow(record: WorkflowRecord, maxParallel: number,
  run: (step: WorkflowStepState) => Promise<void>, signal?: AbortSignal): Promise<void> {
  if (!Number.isFinite(maxParallel) || maxParallel < 1) throw new Error('delegation_disabled');
  const active = new Map<string, Promise<void>>();
  let failure: unknown;
  for (;;) {
    if (!failure && !signal?.aborted && !record.steps.some(s => s.effectOutcome === 'unknown')) {
      for (const step of readyWorkflowSteps(record)) {
        if (active.size >= maxParallel) break;
        if (step.dependsOn.some(id => active.has(id))) continue;
        if (record.steps.some(other => active.has(other.id) && overlappingWriters(step, other))) continue;
        step.status = 'running';
        const execution = run(step).catch(error => { failure ??= error; }).finally(() => { active.delete(step.id); });
        active.set(step.id, execution);
      }
    }
    if (!active.size) break;
    await Promise.race(active.values());
  }
  if (failure) throw failure;
  if (signal?.aborted) record.status = 'aborted';
}
