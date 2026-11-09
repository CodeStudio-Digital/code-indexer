import type { RunBatchOptions, RunBatchStatement } from './types.js';
import { hasMultipleStatements, isReadStatement, stripSqlNoise } from './sql/read-guard.js';

export interface BatchOutcome {
  state: 'completed' | 'failed' | 'cancelled';
  effect: 'not_started' | 'committed' | 'rolled_back' | 'partial' | 'unknown';
  atomicity: 'transactional' | 'best_effort';
  completedStatements: number;
  failedStatement?: number;
}

export class DbBatchError extends Error {
  constructor(message: string, readonly outcome: BatchOutcome, cause?: unknown) {
    super(message, { cause });
    this.name = 'DbBatchError';
  }
}

/** Validate before acquisition: session/transaction control belongs to the driver. */
export function validateBatch(statements: RunBatchStatement[], readOnly = false): void {
  for (const entry of statements) {
    const sql = typeof entry === 'string' ? entry : entry.sql;
    if (hasMultipleStatements(sql) || /^(?:BEGIN|COMMIT|ROLLBACK|END|START\s+TRANSACTION|SET\s+(?:AUTOCOMMIT|TRANSACTION)|SAVEPOINT|RELEASE)\b/i.test(stripSqlNoise(sql).trim())) {
      throw new DbBatchError('Batch entries must be single statements without transaction control.', {
        state: 'failed', effect: 'not_started', atomicity: 'transactional', completedStatements: 0,
      });
    }
    if (readOnly && !isReadStatement(sql)) throw new DbBatchError('Connection is read-only — batch contains a write.', {
      state: 'failed', effect: 'not_started', atomicity: 'transactional', completedStatements: 0,
    });
  }
}

/** An attempted COMMIT with no acknowledgement always has an unknown effect. */
export class BatchTracker {
  started = false;
  committing = false;
  completed = 0;
  constructor(private atomicity: BatchOutcome['atomicity'], private opts: RunBatchOptions) {}
  dispatch(): void { this.opts.signal?.throwIfAborted(); this.opts.beforeDispatch?.(); }
  success(effect: 'committed' | 'rolled_back' = 'committed'): BatchOutcome {
    return { state: 'completed', effect, atomicity: this.atomicity, completedStatements: this.completed };
  }
  failure(error: unknown, rollbackConfirmed: boolean): DbBatchError {
    return new DbBatchError(error instanceof Error ? error.message : String(error), {
      state: this.opts.signal?.aborted ? 'cancelled' : 'failed',
      effect: this.committing ? 'unknown' : !this.started ? 'not_started'
        : !rollbackConfirmed ? 'unknown' : this.atomicity === 'transactional' ? 'rolled_back' : 'partial',
      atomicity: this.atomicity, completedStatements: this.completed,
      failedStatement: this.completed + 1,
    }, error);
  }
}
