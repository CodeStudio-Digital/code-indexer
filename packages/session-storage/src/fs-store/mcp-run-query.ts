import { setImmediate as yieldEventLoop } from 'node:timers/promises';
import type { CatalogEntry, SessionId } from '@mcp/session-storage';
import { coderMetadata, normalizeStatus } from './session-projection.js';

export interface FsMcpRunQuery {
  principal: string;
  profileId?: string | null;
  projectId?: number;
  signal?: AbortSignal;
  limit?: number;
  activeSessionIds?: ReadonlySet<SessionId>;
}

/** Metadata-only catalog query. No transcript, metrics or bundle hydration is
 * needed to rank public MCP runs or count every active run for a principal. */
export async function queryMcpRunMetadata(entries: readonly CatalogEntry[], query: FsMcpRunQuery) {
  query.signal?.throwIfAborted();
  const limit = Math.max(0, Math.min(200, Math.trunc(Number.isFinite(query.limit) ? query.limit! : 50)));
  const matches: Array<{ entry: CatalogEntry; createdAt: number }> = [];
  const active_ids: SessionId[] = [];
  let total_count = 0;
  let boundary = performance.now();
  for (let index = 0; index < entries.length; index++) {
    if (index % 128 === 0) query.signal?.throwIfAborted();
    const entry = entries[index]!;
    const value = entry.session.metadata.mcp_agent_run;
    const metadata = value && typeof value === 'object' && !Array.isArray(value)
      ? value as Readonly<Record<string, unknown>> : undefined;
    if (entry.session.kind === 'coder' && entry.session.storage_scope.kind === 'project'
      && metadata
      && metadata.schema_version === 1 && metadata.principal === query.principal
      && (query.profileId === undefined || metadata.profile_id === query.profileId)
      && (query.projectId === undefined || entry.session.owner_project_id === query.projectId)
      && (!query.activeSessionIds || query.activeSessionIds.has(entry.session.id))) {
      total_count++;
      if (query.activeSessionIds) active_ids.push(entry.session.id);
      if (limit > 0) {
        const createdAt = Date.parse(entry.session.created_at);
        let low = 0; let high = matches.length;
        while (low < high) {
          const middle = (low + high) >>> 1;
          const candidate = matches[middle]!;
          const order = candidate.createdAt - createdAt
            || String(entry.session.id).localeCompare(String(candidate.entry.session.id));
          if (order < 0) high = middle; else low = middle + 1;
        }
        if (low < limit) { matches.splice(low, 0, { entry, createdAt }); if (matches.length > limit) matches.pop(); }
      }
    }
    if (index % 128 === 0 && performance.now() - boundary >= 4) {
      await yieldEventLoop(); boundary = performance.now();
    }
  }
  query.signal?.throwIfAborted();
  // A quota query needs only identities/counts, including runs older than the
  // most recent page. It never loads final responses to infer activity.
  if (limit === 0) return { items: [], total_count, active_ids };
  return { total_count, active_ids, items: matches.map(({ entry }) => ({
    id: entry.session.id, project_id: entry.session.owner_project_id,
    agent: coderMetadata(entry.session.metadata).agent, status: normalizeStatus(entry.state?.status),
    metadata: entry.session.metadata, created_at: entry.session.created_at,
    updated_at: entry.state?.updated_at ?? entry.session.updated_at,
  })) };
}
