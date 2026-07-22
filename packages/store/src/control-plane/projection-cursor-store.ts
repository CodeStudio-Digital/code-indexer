import type DatabaseConstructor from 'better-sqlite3';
import type { ProjectionCursor } from '@mcp/agent-runtime-contracts';

type DB = InstanceType<typeof DatabaseConstructor>;

interface CursorRow {
  projection_id: string;
  partition_key: string;
  last_global_seq: number;
  projection_version: string;
  updated_at: string;
}

export class ProjectionCursorConflictError extends Error {
  constructor(projectionId: string, partitionKey: string, detail: string) {
    super(`Projection cursor ${projectionId}/${partitionKey} conflict: ${detail}`);
    this.name = 'ProjectionCursorConflictError';
  }
}

function hydrate(row: CursorRow): ProjectionCursor {
  return {
    projectionId: row.projection_id,
    partitionKey: row.partition_key,
    lastGlobalSeq: row.last_global_seq,
    projectionVersion: row.projection_version,
    updatedAt: row.updated_at,
  };
}

export class ProjectionCursorStore {
  constructor(private readonly db: DB) {}

  get(projectionId: string, partitionKey: string): ProjectionCursor | null {
    const row = this.db.prepare(`
      SELECT * FROM runtime_projection_cursors
      WHERE projection_id = ? AND partition_key = ?
    `).get(projectionId, partitionKey) as CursorRow | undefined;
    return row ? hydrate(row) : null;
  }

  initialize(
    projectionId: string,
    partitionKey: string,
    projectionVersion: string,
    updatedAt = new Date().toISOString(),
  ): ProjectionCursor {
    this.db.prepare(`
      INSERT OR IGNORE INTO runtime_projection_cursors (
        projection_id, partition_key, last_global_seq, projection_version, updated_at
      ) VALUES (?, ?, 0, ?, ?)
    `).run(projectionId, partitionKey, projectionVersion, updatedAt);
    const cursor = this.get(projectionId, partitionKey)!;
    if (cursor.projectionVersion !== projectionVersion) {
      throw new ProjectionCursorConflictError(
        projectionId,
        partitionKey,
        `projection version is ${cursor.projectionVersion}, expected ${projectionVersion}`,
      );
    }
    return cursor;
  }

  advance(
    projectionId: string,
    partitionKey: string,
    expectedLastGlobalSeq: number,
    nextGlobalSeq: number,
    projectionVersion: string,
    updatedAt = new Date().toISOString(),
  ): ProjectionCursor {
    if (!Number.isSafeInteger(expectedLastGlobalSeq) || expectedLastGlobalSeq < 0) {
      throw new RangeError('expectedLastGlobalSeq must be a non-negative safe integer');
    }
    if (!Number.isSafeInteger(nextGlobalSeq) || nextGlobalSeq < expectedLastGlobalSeq) {
      throw new RangeError('nextGlobalSeq must be a safe integer >= expectedLastGlobalSeq');
    }
    const current = this.get(projectionId, partitionKey);
    if (!current) {
      throw new ProjectionCursorConflictError(projectionId, partitionKey, 'cursor is not initialized');
    }
    if (current.lastGlobalSeq !== expectedLastGlobalSeq) {
      throw new ProjectionCursorConflictError(
        projectionId,
        partitionKey,
        `last sequence is ${current.lastGlobalSeq}, expected ${expectedLastGlobalSeq}`,
      );
    }
    if (current.projectionVersion !== projectionVersion) {
      throw new ProjectionCursorConflictError(
        projectionId,
        partitionKey,
        `projection version is ${current.projectionVersion}, expected ${projectionVersion}`,
      );
    }
    const result = this.db.prepare(`
      UPDATE runtime_projection_cursors SET
        last_global_seq = ?, updated_at = ?
      WHERE projection_id = ? AND partition_key = ?
        AND last_global_seq = ? AND projection_version = ?
    `).run(
      nextGlobalSeq,
      updatedAt,
      projectionId,
      partitionKey,
      expectedLastGlobalSeq,
      projectionVersion,
    );
    if (result.changes !== 1) {
      throw new ProjectionCursorConflictError(projectionId, partitionKey, 'cursor changed concurrently');
    }
    return this.get(projectionId, partitionKey)!;
  }
}
