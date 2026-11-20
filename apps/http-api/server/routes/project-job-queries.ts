import type { HttpContext } from '@mcp/shared/http/router.js';
import { ApiError } from '@mcp/api-bus';
import type { SemanticJobQueryPort, ProjectJobScope } from '../../sse/semantic-job-query-port.js';

export function readProjectJobPage(c: HttpContext, query: SemanticJobQueryPort, namespaces: string[]) {
  const rawLimit = c.req.query('limit'); const rawBefore = c.req.query('before_id');
  const limit = rawLimit === undefined ? 100 : Number(rawLimit);
  const beforeId = rawBefore === undefined ? undefined : Number(rawBefore);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200
    || beforeId !== undefined && (!Number.isSafeInteger(beforeId) || beforeId < 1)) {
    throw new ApiError('invalid_query', 400, 'limit must be 1..200 and before_id a positive integer');
  }
  return query.projectJobsPage({ namespaces, limit, beforeId }, c.req.raw.signal);
}

export async function readCurrentProjectJobs(query: SemanticJobQueryPort, scopes: ProjectJobScope[], signal: AbortSignal) {
  const result: Awaited<ReturnType<SemanticJobQueryPort['currentProjectJobs']>> = [];
  for (let offset = 0; offset < scopes.length; offset += 128) {
    signal.throwIfAborted();
    const batch = scopes.slice(offset, offset + 128);
    const rows = await query.currentProjectJobs(batch, signal);
    signal.throwIfAborted();
    if (rows.length !== batch.length) throw new Error('Semantic job summary response differs from requested projects');
    result.push(...rows);
  }
  return result;
}
