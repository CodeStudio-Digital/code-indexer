/**
 * Handlers for the `runs` namespace — indexer run provenance.
 * Wraps `db.getRuns(projectId)` and `db.getRun(id)`.
 */

import { ApiError, type RunsApi } from '@mcp/api-bus';
import type { HandlerDeps } from '../types.js';

export function createRunsHandlers(deps: HandlerDeps): RunsApi {
  const { db } = deps;

  return {
    async list({ projectId }) {
      return db.getRuns(projectId) as never;
    },

    async get({ id }) {
      const run = db.getRun(id);
      if (!run) throw new ApiError('not_found', 404, 'run not found');
      return run as never;
    },
  };
}
