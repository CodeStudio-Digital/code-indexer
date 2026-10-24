import type { DirtyEvent } from '@mcp/services/services/project-index/index.js';
import {
codeNamespace
} from '@mcp/shared/vector-namespace.js';
import { CODE_DELTA_BUSY_TIMEOUT_MS,CODE_DELTA_RETRY_BASE_MS,CODE_DELTA_RETRY_MAX_MS,isSqliteBusyError,mergeCodeDeltaCursor } from './semantic-coordinator-shared.js';

import type { SemanticCoordinatorContext } from './semantic-coordinator-context.js';

export const operations = {
noteCodeDelta(this: SemanticCoordinatorContext,
    projectId: number,
    events: readonly DirtyEvent[] = [],
    previousItemKeys: readonly string[] = [],
  ): void {
    if (this.disposed || this.embeddingDisabled('code')) return;
    if (this.pendingCodeDeltas.has(projectId)) {
      // Preserve event order while an earlier busy write is waiting to retry;
      // a newer same-path event must win inside that queued batch.
      this.queueCodeDeltaRetry(projectId, events, previousItemKeys);
      return;
    }
    try {
      // This path is invoked synchronously from Electron-main's file watcher.
      // Never inherit the worker-oriented 5s busy timeout here: fail fast,
      // coalesce in memory, and retry after the central writer yields.
      this.deps.semanticStore.withBusyTimeout(CODE_DELTA_BUSY_TIMEOUT_MS, () => {
        this.persistCodeDelta(projectId, events, previousItemKeys);
      });
      this.codeDeltaRetryAttempts.delete(projectId);
    } catch (error) {
      if (!isSqliteBusyError(error)) throw error;
      this.queueCodeDeltaRetry(projectId, events, previousItemKeys);
    }
  },

persistCodeDelta(this: SemanticCoordinatorContext,
    projectId: number,
    events: readonly DirtyEvent[],
    previousItemKeys: readonly string[],
  ): void {
    const namespace = codeNamespace(projectId);
    if (!this.allowsNamespaceMutation(namespace)) return;
    const state = this.deps.semanticStore.listNamespaceGenerations({ namespace })[0];
    const normalized = events.length > 0
      ? Array.from(new Map(events.map((event) => [
          `${event.kind}\0${event.path}`,
          { kind: event.kind, path: event.path.replace(/\\/g, '/') },
        ])).values())
      : [{ kind: 'upsert' as const, path: '*' }];
    const generationId = state?.building_generation_id ?? state?.active_generation_id ?? null;
    const kind = generationId === null ? 'backfill' as const : 'delta' as const;
    const existing = this.deps.semanticStore.listJobs({ namespace, statuses: ['pending', 'paused'], kinds: [kind] }).find((job) =>
      job.generation_id === generationId
      && job.kind === kind
      && (job.status === 'pending' || job.status === 'paused')
      && job.cursor?.reason === 'code-delta');
    const cursor = mergeCodeDeltaCursor(existing?.cursor ?? null, normalized, previousItemKeys);
    const nextExpected = cursor.events.length;
    const previousExpected = existing?.expected_items ?? 0;
    if (existing) {
      this.deps.semanticStore.updateJob(existing.id, {
        status: 'pending',
        cursor: {
          reason: 'code-delta',
          requires_explicit_reindex: cursor.events.some((event) => event.path === '*'),
          ...cursor,
        },
        expected_items: nextExpected,
        processed_items: 0,
        failed_items: 0,
        error: null,
      });
    } else {
      this.deps.semanticStore.createJob({
        generation_id: generationId,
        namespace,
        kind,
        priority: 40,
        cursor: {
          reason: 'code-delta',
          requires_explicit_reindex: cursor.events.some((event) => event.path === '*'),
          ...cursor,
        },
        expected_items: nextExpected,
      });
    }
    if (state && generationId !== null) {
      this.deps.semanticStore.updateNamespaceProgress(namespace, {
        delta_items: Math.max(0, state.delta_items + nextExpected - previousExpected),
      });
    }
  },

queueCodeDeltaRetry(this: SemanticCoordinatorContext,
    projectId: number,
    events: readonly DirtyEvent[],
    previousItemKeys: readonly string[],
  ): void {
    let pending = this.pendingCodeDeltas.get(projectId);
    if (!pending) {
      pending = new Map();
      this.pendingCodeDeltas.set(projectId, pending);
    }
    const normalized = events.length > 0
      ? events
      : [{ kind: 'upsert' as const, path: '*' }];
    for (const event of normalized) {
      const path = event.path.replace(/\\/g, '/');
      if (path === '*') {
        pending.clear();
        pending.set(path, { kind: 'upsert', path });
      } else if (!pending.has('*')) {
        pending.set(path, { kind: event.kind, path });
      }
    }
    if (!pending.has('*') && previousItemKeys.length > 0) {
      let keys = this.pendingCodeDeltaPreviousKeys.get(projectId);
      if (!keys) {
        keys = new Set();
        this.pendingCodeDeltaPreviousKeys.set(projectId, keys);
      }
      for (const key of previousItemKeys) keys.add(key);
    } else if (pending.has('*')) {
      this.pendingCodeDeltaPreviousKeys.delete(projectId);
    }
    if (this.codeDeltaRetryTimers.has(projectId) || this.disposed) return;

    const attempt = (this.codeDeltaRetryAttempts.get(projectId) ?? 0) + 1;
    this.codeDeltaRetryAttempts.set(projectId, attempt);
    const delayMs = Math.min(
      CODE_DELTA_RETRY_MAX_MS,
      CODE_DELTA_RETRY_BASE_MS * (2 ** Math.min(attempt - 1, 5)),
    );
    const timer = setTimeout(() => {
      this.codeDeltaRetryTimers.delete(projectId);
      const queued = this.pendingCodeDeltas.get(projectId);
      if (!queued || queued.size === 0 || this.disposed) return;
      const queuedKeys = [...(this.pendingCodeDeltaPreviousKeys.get(projectId) ?? [])];
      this.pendingCodeDeltas.delete(projectId);
      this.pendingCodeDeltaPreviousKeys.delete(projectId);
      this.noteCodeDelta(projectId, [...queued.values()], queuedKeys);
    }, delayMs);
    timer.unref?.();
    this.codeDeltaRetryTimers.set(projectId, timer);
  }
};
