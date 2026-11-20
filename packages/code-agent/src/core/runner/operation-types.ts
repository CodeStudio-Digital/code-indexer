
export type AsyncOperationKind =
  | 'provider'
  | 'tool'
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
  /** Whether this event observed semantic progress or transport-only liveness. */
  signal?: 'progress' | 'heartbeat';
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
