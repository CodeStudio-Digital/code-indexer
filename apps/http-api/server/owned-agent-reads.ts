import type { Hono } from 'hono';
import { createAgentReadClient } from '../../mcp-server/agent-read-client.js';
import type { AgentReadName } from '@mcp/code-agent/ports/agent-read-port.js';
import type { ServerDeps } from './deps.js';

/** Use the same Hono application as this worker owner. Internal MCP must never
 * find another CodeStudio instance by falling back to a configured TCP port. */
export function createOwnedAgentReads(app: Hono, deps: Pick<ServerDeps, 'sessionStore' | 'config'>) {
  return { async read(projectId: number, name: AgentReadName, input: Record<string, unknown>, signal: AbortSignal) {
    signal.throwIfAborted();
    if (!Number.isSafeInteger(projectId) || projectId <= 0) throw new Error('Agent reads require a project owner');
    const manager = createAgentReadClient(deps.config.dashboard.port, async (path, requestInit) => {
      const requestSignal = requestInit?.signal ? AbortSignal.any([signal, requestInit.signal]) : signal;
      requestSignal.throwIfAborted();
      if (requestInit?.method && requestInit.method !== 'GET') throw new Error('Agent read transport rejects mutations');
      const parsed = new URL(path, 'http://owned.invalid');
      if (parsed.pathname === '/api/coder/mcp-runs') {
        const page = await deps.sessionStore.listMcpRunMetadata({ principal: 'local-dev', projectId,
          profileId: null, limit: Number(parsed.searchParams.get('limit') ?? 50), signal: requestSignal });
        requestSignal.throwIfAborted(); return Response.json(page);
      }
      const session = /^\/api\/coder\/sessions\/([^/]+)$/.exec(parsed.pathname);
      if (session) {
        const row = await deps.sessionStore.getSession(decodeURIComponent(session[1]!));
        requestSignal.throwIfAborted();
        const metadata = row?.metadata?.mcp_agent_run;
        const marker = metadata && typeof metadata === 'object' && !Array.isArray(metadata)
          ? metadata as Readonly<Record<string, unknown>> : undefined;
        if (!row || row.project_id !== projectId || !marker
          || marker.principal !== 'local-dev' || marker.profile_id !== null) {
          return Response.json({ error: 'Unknown agent run' }, { status: 404 });
        }
      } else if (!['/api/coder/agents', '/api/coder/providers'].includes(parsed.pathname)) {
        throw new Error('Unknown owned agent read path');
      }
      const response = await app.request(path, { ...requestInit, signal: requestSignal });
      requestSignal.throwIfAborted(); return response;
    });
    if (name === 'list_agents') return manager.catalog(signal);
    if (name === 'list_agent_runs') return { runs: await manager.list(undefined, Number(input.limit ?? 50), signal) };
    if (name !== 'get_agent_run' && name !== 'get_agent_result') throw new Error('Unknown owned agent read');
    const run = await manager.get(String(input.run_id ?? ''), undefined, signal);
    if (name === 'get_agent_run') return run;
    return { run_id: run.id, status: run.status, session_id: run.sessionId, result: run.finalText, error: run.error };
  } };
}
