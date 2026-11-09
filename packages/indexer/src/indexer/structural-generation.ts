import { randomUUID } from 'node:crypto';
import type { CodeIndexDB } from '@mcp/store/db.js';
import { persistPreparedFileStructural, type PreparedFileStructural } from './indexer/process-file-structural.js';
import { removeFilesStructural } from './structural-incremental.js';

/** Parse into bounded durable chunks, then publish in one WAL transaction.
 * Readers keep their previous SQLite snapshot throughout publication. A crash
 * before COMMIT leaves the active generation intact; next reconciliation drops
 * the abandoned staging, re-stats disk and never replays stale prepared values.
 * Must be owned by the existing per-project structural writer lock. */
export class StructuralGeneration {
  readonly generation = randomUUID();
  private sequence = 0;
  private bytes = 0;
  private readonly raw;
  constructor(private db: CodeIndexDB, private projectId: number) {
    this.raw = db.projectScopedDb(projectId);
    this.raw.prepare('DELETE FROM structural_build_chunks WHERE project_id=?').run(projectId);
  }
  stage(prepared: PreparedFileStructural): void {
    const payload = JSON.stringify(prepared);
    const bytes = Buffer.byteLength(payload);
    if (bytes > 8 * 1024 * 1024 || this.bytes + bytes > 2 * 1024 ** 3) throw new Error('Structural staging budget exceeded; previous generation preserved');
    this.raw.prepare('INSERT INTO structural_build_chunks VALUES(?,?,?,?)').run(this.projectId, this.generation, this.sequence++, payload);
    this.bytes += bytes;
  }
  publish(deletes: string[], signal?: AbortSignal): { indexed: number; removed: number } {
    return this.db.indexTransaction(this.projectId, () => {
      signal?.throwIfAborted();
      let indexed = 0;
      // A live SQLite iterator prevents nested SAVEPOINTs on this connection.
      // Fetch one indexed chunk at a time, with no statement held while writing.
      const get = this.raw.prepare('SELECT payload FROM structural_build_chunks WHERE project_id=? AND generation=? AND sequence=?');
      for (let sequence = 0; sequence < this.sequence; sequence++) {
        const row = get.get(this.projectId, this.generation, sequence) as { payload: string } | undefined;
        if (!row) throw new Error('Structural generation is missing a staged chunk');
        signal?.throwIfAborted();
        persistPreparedFileStructural(this.db, this.projectId, JSON.parse(row.payload));
        indexed++;
      }
      const removed = removeFilesStructural(this.db, this.projectId, deletes).removed;
      this.raw.prepare(`INSERT INTO structural_revisions(project_id,generation,revision) VALUES(?,?,1)
        ON CONFLICT(project_id) DO UPDATE SET generation=excluded.generation,revision=revision+1`).run(this.projectId, this.generation);
      this.discard();
      return { indexed, removed };
    });
  }
  discard(): void { this.raw.prepare('DELETE FROM structural_build_chunks WHERE project_id=? AND generation=?').run(this.projectId, this.generation); }
}
