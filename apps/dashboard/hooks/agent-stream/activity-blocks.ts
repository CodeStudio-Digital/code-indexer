import type {
  StreamActivityBlock,
  StreamActivityKind,
  StreamActivityStatus,
  StreamBlock,
} from './types.js';

export interface ActivityPatch {
  id: string;
  kind?: StreamActivityKind;
  label?: string;
  status?: StreamActivityStatus;
  phase?: string;
  note?: string;
  startedAt?: number;
  elapsedMs?: number;
  idleMs?: number;
  deadlineMs?: number;
  parentOpId?: string;
}

export function upsertActivity(blocks: StreamBlock[], patch: ActivityPatch): boolean {
  const now = Date.now();
  const index = blocks.findIndex((b) => b.type === 'activity' && b.id === patch.id);
  const previous = index >= 0 ? blocks[index] : undefined;
  const prev = previous && previous.type === 'activity' ? previous : undefined;
  const startedAt = patch.startedAt ?? prev?.startedAt ?? (
    patch.elapsedMs != null ? now - patch.elapsedMs : now
  );
  const phase = patch.phase ?? prev?.phase;
  const note = patch.note ?? prev?.note;
  const elapsedMs = patch.elapsedMs ?? prev?.elapsedMs;
  const idleMs = patch.idleMs ?? prev?.idleMs;
  const deadlineMs = patch.deadlineMs ?? prev?.deadlineMs;
  const parentOpId = patch.parentOpId ?? prev?.parentOpId;
  const next: StreamActivityBlock = {
    type: 'activity',
    id: patch.id,
    kind: patch.kind ?? prev?.kind ?? 'operation',
    label: patch.label ?? prev?.label ?? patch.id,
    status: patch.status ?? prev?.status ?? 'running',
    startedAt,
    lastEventAt: now,
    ...(phase ? { phase } : {}),
    ...(note ? { note } : {}),
    ...(elapsedMs != null ? { elapsedMs } : {}),
    ...(idleMs != null ? { idleMs } : {}),
    ...(deadlineMs != null ? { deadlineMs } : {}),
    ...(parentOpId ? { parentOpId } : {}),
  };
  if (index >= 0) blocks[index] = next;
  else blocks.push(next);
  return true;
}

export function finishActivity(blocks: StreamBlock[], patch: ActivityPatch): boolean {
  const status = patch.status ?? 'completed';
  const index = blocks.findIndex((b) => b.type === 'activity' && b.id === patch.id);
  if (index < 0 && status === 'completed') return false;
  return upsertActivity(blocks, { ...patch, status });
}

export function removeActivity(blocks: StreamBlock[], id: string): boolean {
  const index = blocks.findIndex((b) => b.type === 'activity' && b.id === id);
  if (index < 0) return false;
  blocks.splice(index, 1);
  return true;
}

export function clearProviderActivities(blocks: StreamBlock[]): boolean {
  let changed = false;
  for (let i = blocks.length - 1; i >= 0; i--) {
    const block = blocks[i];
    if (block.type !== 'activity' || block.kind !== 'provider') continue;
    if (block.status === 'failed' || block.status === 'timed_out' || block.status === 'aborted') continue;
    blocks.splice(i, 1);
    changed = true;
  }
  return changed;
}

export function kindFromOperation(value: unknown): StreamActivityKind {
  if (value === 'provider' || value === 'tool' || value === 'spawn_agent' || value === 'subagent' || value === 'task') {
    return value;
  }
  return 'operation';
}

// ─── Patch derivations (shared by the chat handlers AND the company
// per-agent reducer, so the pill text is identical in both surfaces) ──

export interface ProviderCallPayload {
  runId?: string;
  turn?: number;
  provider?: string;
  model?: string;
  toolCount?: number;
  historyChars?: number;
}

/** Build the activity patch for a `provider_call` event — `zai:glm-5.1`,
 *  "calling provider with N tools". Single source of truth for the pill. */
export function activityPatchFromProviderCall(d: ProviderCallPayload): ActivityPatch {
  return {
    id: `provider-chat:${String(d.runId ?? 'run')}:${String(d.turn ?? 0)}`,
    kind: 'provider',
    label: `${String(d.provider ?? 'provider')}:${String(d.model ?? 'model')}`,
    phase: 'provider_call',
    note: `calling provider${d.toolCount != null ? ` with ${d.toolCount} tools` : ''}`,
    status: 'running',
  };
}

export interface OperationPayload {
  opId?: string;
  parentOpId?: string;
  kind?: string;
  label?: string;
  phase?: string;
  status?: string;
  startedAt?: number;
  elapsedMs?: number;
  idleMs?: number;
  deadlineMs?: number;
  note?: string;
}

/** Build the activity patch for an `operation_*` event (nested sub-agent /
 *  task ops). Shared by the chat handlers and the company per-agent reducer. */
export function activityPatchFromOperation(d: OperationPayload): ActivityPatch {
  const opId = String(d.opId ?? 'operation');
  return {
    id: opId,
    kind: kindFromOperation(d.kind),
    label: String(d.label ?? opId),
    phase: d.phase,
    note: d.note,
    status: statusFromOperation(d.status),
    startedAt: typeof d.startedAt === 'number' ? d.startedAt : undefined,
    elapsedMs: typeof d.elapsedMs === 'number' ? d.elapsedMs : undefined,
    idleMs: typeof d.idleMs === 'number' ? d.idleMs : undefined,
    deadlineMs: typeof d.deadlineMs === 'number' ? d.deadlineMs : undefined,
    parentOpId: typeof d.parentOpId === 'string' ? d.parentOpId : undefined,
  };
}

export interface ToolProgressPayload {
  id: string;
  name: string;
  elapsedMs: number;
  note?: string;
  kind?: 'heartbeat' | 'progress';
  idleMs?: number;
}

/** Activity kind inferred from a tool_progress id/name (provider.chat,
 *  subagent:, execute_tasks → their own kinds; else generic operation). */
export function activityKindFromToolProgress(id: string, name: string): StreamActivityKind {
  if (name === 'provider.chat' || id.startsWith('provider-chat:') || id.startsWith('pre-think:')) return 'provider';
  if (name.startsWith('subagent:')) return 'subagent';
  if (name === 'execute_tasks') return 'task';
  return 'operation';
}

/** Build the activity patch for a `tool_progress` heartbeat that has no
 *  matching tool block (provider.chat / subagent / task in flight). */
export function activityPatchFromToolProgress(d: ToolProgressPayload): ActivityPatch {
  return {
    id: d.id,
    kind: activityKindFromToolProgress(d.id, d.name),
    label: d.name,
    phase: d.name === 'provider.chat' ? 'awaiting provider' : 'running',
    note: d.note,
    elapsedMs: d.elapsedMs,
    idleMs: d.idleMs,
    status: 'running',
  };
}

export function statusFromOperation(value: unknown): StreamActivityStatus {
  if (value === 'completed' || value === 'failed' || value === 'timed_out' || value === 'aborted') return value;
  return 'running';
}
