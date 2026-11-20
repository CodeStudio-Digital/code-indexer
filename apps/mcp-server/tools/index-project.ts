import { basename, resolve } from 'node:path';
import { requestMcpLocalServer } from '@mcp/indexer/agent-tools/loopback/server-control.js';
import { defineTool, mcpAccess, type McpToolResult } from '../tool.js';

/** Owner-server mutation: application/CLI surface only, never part of the index tool core. */
export const index_project = defineTool({
  name: 'index_project',
  tier: 'admin',
  ...mcpAccess('admin'),
  description:
    'Reconcile the structural index for one project, then start its configured semantic generation. ' +
    'Structural indexing extracts files, symbols, references and dependencies; semantic work runs in the server-owned worker. ' +
    'Use rebuild_semantic only when you intentionally want to replace the active vector generation.',
  inputSchema: {
    type: 'object',
    properties: {
      project_path: { type: 'string', description: 'Path to project root' },
      rebuild_semantic: {
        type: 'boolean',
        description: 'Build a replacement semantic generation instead of starting/catching up the current one.',
      },
    },
    required: ['project_path'],
  },
  handler: async (args, ctx) => {
    ctx.signal?.throwIfAborted();
    if (typeof args.project_path !== 'string' || !args.project_path.trim() || args.project_path.length > 32768
      || args.project_path.includes('\0') || (args.rebuild_semantic != null && typeof args.rebuild_semantic !== 'boolean')) throw new Error('Invalid project indexing arguments');
    const projectPath = resolve(args.project_path as string);
    const uncertain = (stage: string): McpToolResult => ({ effectOutcome: 'unknown',
      text: `Indexing lost confirmation during ${stage}. Inspect the project index and its jobs before authorizing another mutation.` });
    let project = ctx.db.getProjectByPath(projectPath);
    if (!project) {
      const created = await requestMcpLocalServer('/api/projects', {
        method: 'POST',
        signal: ctx.signal,
        body: JSON.stringify({ name: basename(projectPath), root_path: projectPath }),
      }, { config: ctx.config });
      if (!created.ok) {
        if (!created.reached || (created.status ?? 500) >= 500) return uncertain('project registration');
        throw new Error(
          `Index writes require the local owner server; project registration failed: ${created.error ?? 'unavailable'}`,
        );
      }
      project = created.body as typeof project;
    }
    if (!project?.id) throw new Error(`Unable to resolve project for ${projectPath}`);
    const structuralResponse = await requestMcpLocalServer(
      `/api/projects/${project.id}/index/structural/reconcile`,
      { method: 'POST', signal: ctx.signal },
      { config: ctx.config, timeoutMs: 190_000 },
    );
    if (!structuralResponse.ok) {
      if (!structuralResponse.reached || (structuralResponse.status ?? 500) >= 500) return uncertain('structural reconciliation');
      throw new Error(
        `Structural indexing requires the local owner server: ${structuralResponse.error ?? 'unavailable'}`,
      );
    }
    const structural = structuralResponse.body as {
      ok?: boolean;
      readiness?: { status?: string; phase?: string };
      status?: { phase?: string; indexedFiles?: number; symbolCount?: number };
    } | null;
    if (structural?.ok === false) {
      const state = structural.readiness?.status ?? structural.status?.phase ?? 'not_ready';
      return `Structural reconciliation is still ${state}; semantic indexing was not started. Retry after the structural index becomes ready.`;
    }

    const semanticAction = args.rebuild_semantic === true ? 'rebuild' : 'start';
    ctx.signal?.throwIfAborted();
    const semanticResponse = await requestMcpLocalServer(`/api/projects/${project.id}/semantic/reindex`, {
      method: 'POST',
      signal: ctx.signal,
      body: JSON.stringify({ action: semanticAction }),
    }, { config: ctx.config, timeoutMs: 10_000 });
    const structuralState = structural?.status?.phase ?? structural?.readiness?.phase ?? 'ready';
    if (!semanticResponse.ok) {
      if (!semanticResponse.reached || (semanticResponse.status ?? 500) >= 500) return uncertain('semantic scheduling');
      return `Structural index is ${structuralState}. Semantic indexing was not started (${semanticResponse.error ?? 'profile disabled or worker unavailable'}); FTS and structural tools remain available.`;
    }
    const semantic = semanticResponse.body as { job?: { id?: number; status?: string }; scheduled?: boolean } | null;
    const job = semantic?.job?.id ? ` job #${semantic.job.id}` : '';
    return `Structural index is ${structuralState}. Semantic ${semanticAction}${job} was accepted by the server-owned worker.`;
  },
});
