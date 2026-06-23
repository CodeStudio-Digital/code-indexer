import type { RunnerEvents } from './events.js';

export type AsyncOperationKind =
  | 'provider'
  | 'tool'
  | 'spawn_agent'
  | 'subagent'
  | 'task'
  | 'other';

export type AsyncOperationStatus =
  | 'running'
  | 'completed'
  | 'failed'
  | 'timed_out'
  | 'aborted';

export interface AsyncOperationSnapshot {
  opId: string;
  parentOpId?: string;
  kind: AsyncOperationKind;
  label: string;
  phase: string;
  status: AsyncOperationStatus;
  startedAt: number;
  lastProgressAt: number;
  deadlineMs?: number;
  elapsedMs: number;
  idleMs: number;
  note?: string;
}

export interface StartOperationArgs {
  opId: string;
  parentOpId?: string;
  kind: AsyncOperationKind;
  label: string;
  phase?: string;
  deadlineMs?: number;
  abortController?: AbortController;
}

interface OperationRecord {
  opId: string;
  parentOpId?: string;
  kind: AsyncOperationKind;
  label: string;
  phase: string;
  status: AsyncOperationStatus;
  startedAt: number;
  lastProgressAt: number;
  deadlineMs?: number;
  abortController?: AbortController;
}

type Emit = <E extends keyof RunnerEvents>(
  event: E,
  ...args: Parameters<RunnerEvents[E]>
) => void;

export class AsyncOperationRegistry {
  private readonly operations = new Map<string, OperationRecord>();

  constructor(private readonly emit: Emit) {}

  start(args: StartOperationArgs): AsyncOperationSnapshot {
    const now = Date.now();
    const record: OperationRecord = {
      opId: args.opId,
      parentOpId: args.parentOpId,
      kind: args.kind,
      label: args.label,
      phase: args.phase ?? 'running',
      status: 'running',
      startedAt: now,
      lastProgressAt: now,
      deadlineMs: args.deadlineMs,
      abortController: args.abortController,
    };
    this.operations.set(args.opId, record);
    const snapshot = this.snapshot(record, now);
    this.emit('operation_started', snapshot);
    return snapshot;
  }

  progress(opId: string, patch: { phase?: string; note?: string } = {}): AsyncOperationSnapshot | null {
    const record = this.operations.get(opId);
    if (!record || record.status !== 'running') return null;
    const now = Date.now();
    record.lastProgressAt = now;
    if (patch.phase) record.phase = patch.phase;
    const snapshot = this.snapshot(record, now, patch.note);
    this.emit('operation_progress', snapshot);
    return snapshot;
  }

  finish(
    opId: string,
    status: Exclude<AsyncOperationStatus, 'running'>,
    patch: { phase?: string; note?: string } = {},
  ): AsyncOperationSnapshot | null {
    const record = this.operations.get(opId);
    if (!record) return null;
    const now = Date.now();
    record.status = status;
    record.phase = patch.phase ?? status;
    record.lastProgressAt = now;
    this.operations.delete(opId);
    const snapshot = this.snapshot(record, now, patch.note);
    this.emit('operation_finished', snapshot);
    return snapshot;
  }

  abort(opId: string, reason = 'aborted'): void {
    const record = this.operations.get(opId);
    if (!record) return;
    try {
      record.abortController?.abort(new Error(reason));
    } catch {
      /* ignore */
    }
    this.finish(opId, 'aborted', { phase: 'aborted', note: reason });
  }

  abortAll(reason = 'run aborted'): void {
    for (const opId of Array.from(this.operations.keys())) {
      this.abort(opId, reason);
    }
  }

  list(): AsyncOperationSnapshot[] {
    const now = Date.now();
    return Array.from(this.operations.values()).map((record) => this.snapshot(record, now));
  }

  private snapshot(record: OperationRecord, now: number, note?: string): AsyncOperationSnapshot {
    return {
      opId: record.opId,
      ...(record.parentOpId ? { parentOpId: record.parentOpId } : {}),
      kind: record.kind,
      label: record.label,
      phase: record.phase,
      status: record.status,
      startedAt: record.startedAt,
      lastProgressAt: record.lastProgressAt,
      ...(record.deadlineMs != null ? { deadlineMs: record.deadlineMs } : {}),
      elapsedMs: now - record.startedAt,
      idleMs: now - record.lastProgressAt,
      ...(note ? { note } : {}),
    };
  }
}
