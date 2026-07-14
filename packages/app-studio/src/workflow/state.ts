import {
  APP_WORKFLOW_PHASE_IDS,
  type AppApproval,
  type AppWorkflowPhase,
  type AppWorkflowPhaseId,
  type AppWorkflowState,
  type AppWorkItem,
} from './types.js';

export function createAppWorkflowState(migratedFrom: number | null = null): AppWorkflowState {
  return {
    v: 5,
    phases: APP_WORKFLOW_PHASE_IDS.map((id, index) => ({
      id,
      status: index === 0 ? 'active' : 'locked',
      bundle: {},
    })),
    release_unlocked: false,
    migrated_from: migratedFrom,
    migrated_at: migratedFrom == null ? null : new Date().toISOString(),
  };
}

export function parseAppWorkflowState(json: string | null | undefined): AppWorkflowState | null {
  if (!json) return null;
  try {
    const value = JSON.parse(json) as Partial<AppWorkflowState>;
    if (value.v !== 5 || !Array.isArray(value.phases)) return null;
    const ids = value.phases.map((phase) => phase?.id);
    if (ids.length !== APP_WORKFLOW_PHASE_IDS.length || APP_WORKFLOW_PHASE_IDS.some((id) => ids.filter((item) => item === id).length !== 1)) return null;
    if (value.phases.some((phase) => !phase || !['locked', 'active', 'attention', 'complete'].includes(phase.status))) return null;
    if (typeof value.release_unlocked !== 'boolean') return null;
    return value as AppWorkflowState;
  } catch {
    return null;
  }
}

export function serializeAppWorkflowState(state: AppWorkflowState): string {
  return JSON.stringify(state);
}

export function deriveAppWorkflowState(
  state: AppWorkflowState,
  approvals: AppApproval[],
  workItems: AppWorkItem[],
): AppWorkflowState {
  const next: AppWorkflowState = JSON.parse(JSON.stringify(state)) as AppWorkflowState;
  const latest = (type: AppApproval['type']) => approvals
    .filter((approval) => approval.type === type && approval.status !== 'superseded')
    .sort((a, b) => b.bundle_revision - a.bundle_revision)[0] ?? null;
  const scope = latest('scope');
  const blueprint = latest('blueprint');
  const release = latest('release');
  const nonTerminalBuild = workItems.some((item) => item.phase === 'build' && !['done', 'cancelled'].includes(item.status));
  const anyBuild = workItems.some((item) => item.phase === 'build');

  const phase = (id: AppWorkflowPhaseId): AppWorkflowPhase => next.phases.find((item) => item.id === id)!;
  phase('define').bundle = scope?.bundle ?? {};
  phase('blueprint').bundle = blueprint?.bundle ?? {};
  phase('build').bundle = blueprint?.bundle ?? {};
  phase('deliver').bundle = release?.bundle ?? blueprint?.bundle ?? {};
  phase('define').status = scope?.status === 'approved' ? 'complete' : scope?.status === 'pending' ? 'attention' : 'active';
  phase('blueprint').status = scope?.status !== 'approved'
    ? 'locked'
    : blueprint?.status === 'approved'
      ? 'complete'
      : blueprint?.status === 'pending'
        ? 'attention'
        : 'active';
  phase('build').status = blueprint?.status !== 'approved'
    ? 'locked'
    : anyBuild && !nonTerminalBuild
      ? 'complete'
      : 'active';
  phase('deliver').status = !anyBuild || nonTerminalBuild
    ? 'locked'
    : release?.status === 'approved'
      ? 'complete'
      : release?.status === 'pending'
        ? 'attention'
        : 'active';
  next.release_unlocked = release?.status === 'approved';
  return next;
}
