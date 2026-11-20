/**
 * Search telemetry over worker RPC follows the HTTP route's model: per key,
 * the claimed id (else the host's), validated by the same validateTelemetryScope.
 * A Company worker's Company session is always the host's.
 */
import { MessageChannel } from 'node:worker_threads';
import { MessageBridge } from '@mcp/orchestrator-host';
import { afterEach, describe, expect, it } from 'vitest';
import { registerWorkerIndexHandlers, type WorkerTelemetryAuthority } from '../worker-index-handlers.js';
import { validateTelemetryScope, type IndexSearchService } from '../../server/index-search-service.js';
import { createRpcSemanticSearchClient } from '../../workers/index-search-rpc.js';

/** Sessions and the project each one covers; project 7 is the searched one. */
const SESSIONS: Record<string, number> = {
  'host-session': 7, 'sub-valid': 7, 'sub-other-project': 8, 'company-host': 7, 'company-other': 7,
};
const deps = {
  sessionStore: { getSession: async (id: string) => id in SESSIONS
    ? { project_id: SESSIONS[id], is_global: false, linked_projects: [] } as never : null },
  db: { getProject: (id: number) => ({ id, name: `p${id}`, root_path: `/p${id}`, is_synthetic: 0 }) },
} as unknown as Parameters<typeof validateTelemetryScope>[0];

const cleanup: Array<() => void> = [];
afterEach(() => { for (const close of cleanup.splice(0)) close(); });

/** The worker client against a host whose search reports the scope it would record. */
function worker(authority: WorkerTelemetryAuthority) {
  const channel = new MessageChannel();
  const main = new MessageBridge({ port: channel.port1 }), side = new MessageBridge({ port: channel.port2 });
  const service = {
    projectSearch: async (input: { projectId: number }, ids: Parameters<typeof validateTelemetryScope>[2]) => ({
      results: [], diagnostics: { scope: await validateTelemetryScope(deps, input.projectId, ids) ?? null },
    }),
  } as unknown as IndexSearchService;
  const off = registerWorkerIndexHandlers(main, () => authority, () => service);
  cleanup.push(() => { off(); main.dispose(); side.dispose(); channel.port1.close(); channel.port2.close(); });
  const client = createRpcSemanticSearchClient(side);
  return async (claimed: { sessionId?: string; companySessionId?: string }) => {
    const reply = await client.searchProject(7, 'q', claimed);
    return (reply.value?.diagnostics as unknown as { scope: unknown }).scope;
  };
}

const coder = () => worker({ ids: { sessionId: 'host-session' } });
const company = () => worker({ ids: { companySessionId: 'company-host' }, fixed: ['companySessionId'] });

describe('search telemetry attribution over worker RPC', () => {
  it('attributes a Company subordinate with a valid session id', async () => {
    expect(await company()({ sessionId: 'sub-valid' })).toEqual({ sessionId: 'sub-valid', companySessionId: 'company-host' });
  });

  it('drops a nonexistent id and a session that does not cover the project, with no second fallback', async () => {
    expect(await company()({ sessionId: 'ghost' })).toEqual({ companySessionId: 'company-host' });
    expect(await company()({ sessionId: 'sub-other-project' })).toEqual({ companySessionId: 'company-host' });
    expect(await coder()({ sessionId: 'ghost' })).toBeNull();
    expect(await coder()({ sessionId: 'sub-other-project' })).toBeNull();
  });

  it('uses the host session when nothing is claimed', async () => {
    expect(await coder()({})).toEqual({ sessionId: 'host-session' });
    expect(await company()({})).toEqual({ companySessionId: 'company-host' });
  });

  it('ignores a claimed Company session that differs from the host one', async () => {
    expect(await company()({ sessionId: 'sub-valid', companySessionId: 'company-other' }))
      .toEqual({ sessionId: 'sub-valid', companySessionId: 'company-host' });
  });
});
