import type {
  ActiveProcess,
  ActiveProcessSource,
  ActiveProcessStatus,
  StreamActivityKind,
} from './types.js';

export interface ActiveProcessPatch {
  id: string;
  source: ActiveProcessSource;
  kind: StreamActivityKind;
  label: string;
  status?: ActiveProcessStatus;
  startedAt?: number;
  phase?: string;
  note?: string;
  elapsedMs?: number;
  idleMs?: number;
  parentId?: string;
  groupId?: string;
  background?: boolean;
}

/** Upsert without resetting the original start time or sparse progress data. */
export function upsertActiveProcess(
  processes: ActiveProcess[],
  patch: ActiveProcessPatch,
  now = Date.now(),
): ActiveProcess[] {
  const index = processes.findIndex((process) => process.id === patch.id);
  const previous = index >= 0 ? processes[index] : undefined;
  const startedAt = patch.startedAt
    ?? previous?.startedAt
    ?? (patch.elapsedMs != null ? now - patch.elapsedMs : now);
  const next: ActiveProcess = {
    ...previous,
    id: patch.id,
    source: patch.source,
    kind: patch.kind,
    label: patch.label,
    status: patch.status ?? previous?.status ?? 'running',
    startedAt,
    updatedAt: now,
    ...(patch.phase !== undefined ? { phase: patch.phase } : {}),
    ...(patch.note !== undefined ? { note: patch.note } : {}),
    ...(patch.elapsedMs !== undefined ? { elapsedMs: patch.elapsedMs } : {}),
    ...(patch.idleMs !== undefined ? { idleMs: patch.idleMs } : {}),
    ...(patch.parentId !== undefined ? { parentId: patch.parentId } : {}),
    ...(patch.groupId !== undefined ? { groupId: patch.groupId } : {}),
    ...(patch.background !== undefined ? { background: patch.background } : {}),
  };
  if (index < 0) return [...processes, next];
  const copy = [...processes];
  copy[index] = next;
  return copy;
}

function upsertActiveProcesses(
  processes: ActiveProcess[],
  patches: ActiveProcessPatch[],
  now = Date.now(),
): ActiveProcess[] {
  return patches.reduce(
    (current, patch) => upsertActiveProcess(current, patch, now),
    processes,
  );
}

export function removeActiveProcesses(
  processes: ActiveProcess[],
  predicate: (process: ActiveProcess) => boolean,
): ActiveProcess[] {
  return processes.filter((process) => !predicate(process));
}

export function replaceActiveProcesses(
  processes: ActiveProcess[],
  predicate: (process: ActiveProcess) => boolean,
  patches: ActiveProcessPatch[],
  now = Date.now(),
): ActiveProcess[] {
  return upsertActiveProcesses(removeActiveProcesses(processes, predicate), patches, now);
}

/** A model turn ended; only detached fire-and-forget work may remain alive. */
export function retainBackgroundProcesses(processes: ActiveProcess[]): ActiveProcess[] {
  return processes.filter((process) => process.background === true);
}

/**
 * Defensive presentation dedup. Rich agent/task rows replace their generic
 * wrapper activity if both event families briefly overlap during hand-off.
 */
export function selectVisibleActiveProcesses(processes: ActiveProcess[]): ActiveProcess[] {
  const hasAgents = processes.some((process) => process.source === 'agent');
  const hasTasks = processes.some((process) => process.source === 'task');
  return processes.filter((process) => {
    if (hasAgents && process.source === 'activity' && process.kind === 'subagent') return false;
    if (hasTasks && process.source === 'activity' && process.kind === 'task') return false;
    if (hasAgents && process.source === 'tool' && AGENT_WRAPPER_TOOLS.has(process.label)) return false;
    if (hasTasks && process.source === 'tool' && process.label === 'execute_tasks') return false;
    return true;
  });
}

export const AGENT_WRAPPER_TOOLS = new Set([
  'spawn_agent',
  'resume_agent',
  'implement_subagent',
  'review_subagent',
]);
