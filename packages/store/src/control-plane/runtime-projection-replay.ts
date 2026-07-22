import type { RuntimeEventEnvelopeV1 } from '@mcp/agent-runtime-contracts';
import { ProjectionCursorStore } from './projection-cursor-store.js';
import { RuntimeJournalStore } from './runtime-journal-store.js';

export interface RuntimeProjection<T = unknown> {
  projectionId: string;
  projectionVersion: string;
  partitionKey: string;
  apply(event: RuntimeEventEnvelopeV1<T>): Promise<void> | void;
}

export interface RuntimeProjectionBatchOptions {
  limit?: number;
}

export interface RuntimeProjectionBatchResult {
  delivered: number;
  lastGlobalSeq: number;
  caughtUp: boolean;
}

function normalizeLimit(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return 100;
  return Math.max(1, Math.min(10_000, Math.floor(value)));
}

/**
 * Replays one partition with at-least-once delivery. The projection effect runs
 * before the cursor CAS, so a crash or competing consumer can redeliver an
 * already-applied event. Projection handlers must therefore be idempotent.
 */
export class RuntimeProjectionReplay {
  constructor(
    private readonly journal: RuntimeJournalStore,
    private readonly cursors: ProjectionCursorStore,
  ) {}

  async runBatch<T = unknown>(
    projection: RuntimeProjection<T>,
    options: RuntimeProjectionBatchOptions = {},
  ): Promise<RuntimeProjectionBatchResult> {
    const limit = normalizeLimit(options.limit);
    let cursor = this.cursors.initialize(
      projection.projectionId,
      projection.partitionKey,
      projection.projectionVersion,
    );
    const events = this.journal.listPartition<T>(
      projection.partitionKey,
      cursor.lastGlobalSeq,
      limit,
    );

    let delivered = 0;
    for (const event of events) {
      await projection.apply(event);
      cursor = this.cursors.advance(
        projection.projectionId,
        projection.partitionKey,
        cursor.lastGlobalSeq,
        event.globalSeq,
        projection.projectionVersion,
      );
      delivered += 1;
    }

    return {
      delivered,
      lastGlobalSeq: cursor.lastGlobalSeq,
      caughtUp: events.length < limit,
    };
  }
}
