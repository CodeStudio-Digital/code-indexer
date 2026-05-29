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

export function statusFromOperation(value: unknown): StreamActivityStatus {
  if (value === 'completed' || value === 'failed' || value === 'timed_out' || value === 'aborted') return value;
  return 'running';
}
