import { randomUUID } from 'node:crypto';
import type { CollaborationFiles } from './files.js';

export interface Revision<T> { schemaVersion: 1; revision: number; operationId: string; value: T }

/** Immutable revision slots are the CAS: only one hard-link publication can win.
 * There is no mutable head/lock to become stale after a crash. Cached heads are
 * hints; readers always check the next slot, including across process boundaries. */
export class CollaborationRevisions {
  private heads = new Map<string, Revision<unknown>>();
  constructor(readonly files: CollaborationFiles) {}
  async read<T>(kind: string, key: string): Promise<Revision<T> | null> {
    const cacheKey = `${kind}:${key}`;
    let head = this.heads.get(cacheKey) as Revision<T> | undefined;
    if (!head) {
      // Slots are contiguous by construction (a writer can publish N+1 only
      // after observing N). Discover the persisted head logarithmically on
      // restart instead of reopening every old tool's lease revision.
      const probe = async (revision: number): Promise<Revision<T> | null> => {
        const row = await this.files.get<Revision<T>>(kind, `${key}:revision:${revision}`);
        if (row && (row.schemaVersion !== 1 || row.revision !== revision)) throw new Error('corrupt_revision: preserved record requires recovery');
        return row;
      };
      const first = await probe(1);
      if (first) {
        head = first;
        let upper = 2;
        while (Number.isSafeInteger(upper)) {
          const found = await probe(upper);
          if (!found) break;
          head = found;
          upper *= 2;
        }
        let low = head.revision + 1;
        let high = Math.min(upper - 1, Number.MAX_SAFE_INTEGER);
        while (low <= high) {
          const middle = low + Math.floor((high - low) / 2);
          const found = await probe(middle);
          if (found) { head = found; low = middle + 1; }
          else high = middle - 1;
        }
      }
    }
    for (;;) {
      const next = await this.files.get<Revision<T>>(kind, `${key}:revision:${(head?.revision ?? 0) + 1}`);
      if (!next) break;
      if (next.schemaVersion !== 1 || next.revision !== (head?.revision ?? 0) + 1) throw new Error('corrupt_revision: preserved record requires recovery');
      head = next;
    }
    if (head) this.heads.set(cacheKey, head);
    return head ?? null;
  }
  async change<T>(kind: string, key: string, initial: T, apply: (value: T) => T,
    expectedRevision?: number, operationId = randomUUID()): Promise<Revision<T>> {
    for (let attempt = 0; attempt < 64; attempt++) {
      const head = await this.read<T>(kind, key);
      if (head?.operationId === operationId) return head;
      if (expectedRevision !== undefined && (head?.revision ?? 0) !== expectedRevision) throw new Error('revision_conflict');
      const candidate: Revision<T> = { schemaVersion: 1, revision: (head?.revision ?? 0) + 1,
        operationId, value: apply(structuredClone(head?.value ?? initial)) };
      const published = await this.files.insert(kind, `${key}:revision:${candidate.revision}`, candidate);
      if (published.operationId === operationId) return published;
    }
    throw new Error('waiting_capacity: concurrent updates; retry the same operation');
  }
}
