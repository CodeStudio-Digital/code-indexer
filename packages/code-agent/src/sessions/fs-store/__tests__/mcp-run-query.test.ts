import { expect, it } from 'vitest';
import type { CatalogEntry } from '@mcp/session-storage';
import { queryMcpRunMetadata } from '../mcp-run-query.js';

it('keeps the latest bounded page and counts older active runs across a large catalog', async () => {
  const entries = Array.from({ length: 10_000 }, (_, index) => ({ session: {
    id: `session-${index}`, kind: 'coder', storage_scope: { kind: 'project', project_id: 7 }, owner_project_id: 7,
    created_at: new Date(index * 1000).toISOString(), updated_at: new Date(index * 1000).toISOString(),
    metadata: { mcp_agent_run: { schema_version: 1, principal: index % 2 ? 'another' : 'owner', profile_id: null } },
  } }) as unknown as CatalogEntry);
  const page = await queryMcpRunMetadata(entries, { principal: 'owner', limit: 3 });
  expect(page.items.map(item => item.id)).toEqual(['session-9998', 'session-9996', 'session-9994']);
  expect(page.total_count).toBe(5000);
  const active = await queryMcpRunMetadata(entries, { principal: 'owner', profileId: null, limit: 0,
    activeSessionIds: new Set([entries[0]!.session.id, entries[1]!.session.id]) });
  expect(active).toEqual({ items: [], total_count: 1, active_ids: ['session-0'] });
});
