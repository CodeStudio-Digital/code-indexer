import type { DirtyEvent, StructuralExecutor } from './types.js';
import type { DirtyQueue } from './dirty-queue.js';
import type { ProjectIndexStatusStore } from './status-store.js';
import { DRAIN_BATCH, yieldToEventLoop } from './service-support.js';

/** Reconcile durable dirty hints under the caller's project lock. */
export async function drainDirtyQueue(projectId: number, dirty: DirtyQueue, getExecutor: () => StructuralExecutor,
  status: ProjectIndexStatusStore, noteDelta: (events: readonly DirtyEvent[], previousItemKeys: readonly string[]) => void,
  enabled: () => boolean): Promise<void> {
    while (enabled() && dirty.size(projectId) > 0) {
      const batch = dirty.takeBatch(projectId, DRAIN_BATCH);
      if (batch.total === 0) break;
      const capturePreviousItems = (
        events: readonly DirtyEvent[],
        previousItemKeys: readonly string[],
      ): void => {
        // markDirty already persisted the path fence before this worker RPC.
        // Merge the worker-captured pre-mutation keys only when there is old
        // structural ownership to preserve for stale-vector cleanup.
        if (previousItemKeys.length > 0) {
          noteDelta(events, previousItemKeys);
        }
      };
      // Events are hints, not the current filesystem state. A replayed delete
      // may refer to a file recreated before the worker restarted. Reconcile
      // both event kinds through the same stat/hash path before acknowledging.
      const paths = [...new Set([...batch.upserts, ...batch.deletes])];
      if (paths.length > 0) {
        const result = await getExecutor().indexFiles(projectId, paths, {
          onChanges: capturePreviousItems,
        });
        if (result.errors > 0) {
          // Old executors without path outcomes conservatively replay all upserts.
          dirty.ack(projectId, batch, result.failedPaths ?? paths);
          throw new Error(`${result.errors} structural delta(s) failed; pending work retained`);
        }
      }
      dirty.ack(projectId, batch);
      status.setDirtyPending(projectId, dirty.size(projectId));
      if (dirty.size(projectId) > 0) await yieldToEventLoop();
    }
  }
