import type { SemanticStore } from '@mcp/store/semantic-store.js';
import type { ProjectJobScope, ProjectJobsPageInput, ProjectJobsPage } from '../sse/semantic-job-query-port.js';

/** Runs only in the SQLite worker. Pages are independent of historical row
 * count; the selected current job is queried separately from recent history. */
export function projectJobsPage(store: SemanticStore, input: ProjectJobsPageInput): ProjectJobsPage {
  const limit = input?.limit ?? 100;
  if (!input || !Array.isArray(input.namespaces) || input.namespaces.length > 4096
    || input.namespaces.some(name => typeof name !== 'string' || !name || name.length > 256)
    || !Number.isSafeInteger(limit) || limit < 1 || limit > 200
    || input.beforeId !== undefined && (!Number.isSafeInteger(input.beforeId) || input.beforeId < 1)) {
    throw new Error('Invalid semantic project jobs page');
  }
  const rows = store.listJobs({ namespaces: input.namespaces, beforeId: input.beforeId, order: 'newest', limit: limit + 1 });
  return { jobs: rows.slice(0, limit), nextBeforeId: rows.length > limit ? rows[limit - 1]!.id : null };
}

export function currentProjectJobs(store: SemanticStore, scopes: ProjectJobScope[]) {
  if (!Array.isArray(scopes) || scopes.length > 128) throw new Error('Invalid semantic project job batch');
  return scopes.map(scope => {
    if (!scope || scope.pausedOnly !== undefined && typeof scope.pausedOnly !== 'boolean') throw new Error('Invalid semantic job scope');
    return store.currentProjectJob(scope.projectId, scope.generationIds, scope.pausedOnly);
  });
}
