import type {
  CompactionCheckpoint,
  CompactionCheckpointResult,
} from '@mcp/code-agent/core/runner/types.js';

export interface DurableCheckpointRetryOutcome {
  checkpoint: CompactionCheckpoint;
  result: CompactionCheckpointResult;
  attempt: number;
}

export interface DurableCheckpointCoordinatorOptions {
  /** Total attempts including the initial submit. */
  maxAttempts?: number;
  /** Turn delay after the initial failure; doubles after each retry. */
  baseBackoffTurns?: number;
  executeRetry?: (
    checkpoint: CompactionCheckpoint,
    attempt: number,
    commit: (checkpoint: CompactionCheckpoint) => Promise<CompactionCheckpointResult>,
  ) => Promise<CompactionCheckpointResult>;
}

interface PendingCheckpoint {
  checkpoint: CompactionCheckpoint;
  attempts: number;
  nextRetryTurn: number;
}

/**
 * Host-side durable checkpoint lifecycle.
 *
 * Only transport/storage failures are retryable. Alignment no-ops are stable
 * for an immutable summarized head after the host flush, so replaying them on
 * every turn can never heal them. A newer checkpoint always supersedes the
 * stale pending snapshot and acts as the rebase.
 */
export class DurableCheckpointCoordinator {
  private readonly maxAttempts: number;
  private readonly baseBackoffTurns: number;
  private pending: PendingCheckpoint | null = null;
  private retryInFlight: Promise<DurableCheckpointRetryOutcome | null> | null = null;

  constructor(
    private readonly commit: (
      checkpoint: CompactionCheckpoint,
    ) => Promise<CompactionCheckpointResult>,
    private readonly options: DurableCheckpointCoordinatorOptions = {},
  ) {
    this.maxAttempts = Math.max(1, options.maxAttempts ?? 3);
    this.baseBackoffTurns = Math.max(1, options.baseBackoffTurns ?? 2);
  }

  get hasPending(): boolean {
    return this.pending !== null;
  }

  get pendingAttempts(): number {
    return this.pending?.attempts ?? 0;
  }

  /** Commit a fresh snapshot, superseding any older pending checkpoint. */
  async submit(
    checkpoint: CompactionCheckpoint,
    turn: number,
  ): Promise<CompactionCheckpointResult> {
    // Do not let an old in-flight retry write state after the rebase.
    if (this.retryInFlight) await this.retryInFlight;
    this.pending = null;
    const result = await this.commit(checkpoint);
    this.captureFailure(checkpoint, result, turn, 1);
    return result;
  }

  /** Retry at most once for this call and only after the exponential turn delay. */
  retry(turn: number, force = false): Promise<DurableCheckpointRetryOutcome | null> {
    if (this.retryInFlight) return Promise.resolve(null);
    const pending = this.pending;
    if (!pending || (!force && turn < pending.nextRetryTurn)) return Promise.resolve(null);

    const attempt = pending.attempts + 1;
    if (attempt > this.maxAttempts) {
      this.pending = null;
      return Promise.resolve(null);
    }

    const operation = (async (): Promise<DurableCheckpointRetryOutcome> => {
      const execute = this.options.executeRetry;
      const result = execute
        ? await execute(pending.checkpoint, attempt, this.commit)
        : await this.commit(pending.checkpoint);
      // `submit` waits for this operation, so this is still the active pending
      // generation while the result is applied.
      this.pending = null;
      this.captureFailure(pending.checkpoint, result, turn, attempt);
      return { checkpoint: pending.checkpoint, result, attempt };
    })();
    this.retryInFlight = operation;
    void operation.then(
      () => { if (this.retryInFlight === operation) this.retryInFlight = null; },
      () => { if (this.retryInFlight === operation) this.retryInFlight = null; },
    );
    return operation;
  }

  private captureFailure(
    checkpoint: CompactionCheckpoint,
    result: CompactionCheckpointResult,
    turn: number,
    attempts: number,
  ): void {
    // `noop` includes unaligned/unsafe boundaries. The summarized head is
    // immutable and commit already flushed the pending assistant turn, so it
    // is non-retryable. A later `submit` is the safe rebase path.
    if (result.status !== 'failed' || attempts >= this.maxAttempts) return;
    const delay = this.baseBackoffTurns * (2 ** Math.max(0, attempts - 1));
    this.pending = {
      checkpoint,
      attempts,
      nextRetryTurn: turn + delay,
    };
  }
}
