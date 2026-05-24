/**
 * Handlers for the `snapshots` namespace. Thin wrapper over the existing
 * `SnapshotService` (apps/http-api/server/routes/snapshots.ts mounts the
 * same operations as Hono routes).
 */

import type { SnapshotsApi } from '@mcp/api-bus';
import type { SnapshotCategory } from '@mcp/shared/types.js';
import type { HandlerDeps } from '../types.js';

export function createSnapshotsHandlers(deps: HandlerDeps): SnapshotsApi {
  const { snapshotService } = deps;

  return {
    async list({ projectId, category }) {
      return snapshotService.list(projectId, category as SnapshotCategory | undefined) as never;
    },

    async create({ projectId, title, category, content, tags }) {
      const result = await snapshotService.create(projectId, {
        title,
        category: category as SnapshotCategory,
        content,
        tags,
      });
      return { ...(result.snap as unknown as Record<string, unknown>), embed_error: result.embedError ?? null } as never;
    },

    async update({ id, ...patch }) {
      const result = await snapshotService.update(id, patch as never);
      return { ok: true as const, embed_error: result.embedError ?? null };
    },

    async delete({ id }) {
      snapshotService.delete(id);
      return { ok: true as const };
    },

    async getForContext({ projectId }) {
      return snapshotService.getForContext(projectId);
    },

    async history({ id }) {
      return snapshotService.getHistory(id) as never;
    },
  };
}
