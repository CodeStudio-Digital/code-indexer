import type { HttpRouter } from '@mcp/shared/http/router.js';
import type { ServerDeps } from '../deps.js';
import { notFound, parseIdParam } from './_helpers.js';
import { memoryCurationTotals } from '@mcp/store/db/agent-memory-curation.js';

export function mountAgentMemoryEvolutionRoutes(app: HttpRouter, deps: ServerDeps): void {
  app.get('/api/projects/:id/agent-memory/overview', c => {
    const projectId = parseIdParam(c);
    if (!deps.db.getProject(projectId)) return notFound(c);
    const scope = projectId === 0 ? 'user' as const : 'project' as const;
    return c.json({ enabled: deps.db.getProjectMemoryEnabled(projectId),
      totals: memoryCurationTotals(deps.db.raw(), scope, projectId),
      usage: deps.db.getAgentMemoryStats(projectId),
      evolution: deps.memoryEvolution?.status({ scope, projectId }) ?? null });
  });
  app.get('/api/projects/:id/agent-memory/evolution', c => {
    const projectId = parseIdParam(c);
    if (!deps.db.getProject(projectId)) return notFound(c);
    if (!deps.memoryEvolution) return c.json({ error: 'memory_evolution_unavailable' }, 503);
    const key = { scope: projectId === 0 ? 'user' as const : 'project' as const, projectId };
    return c.json(deps.memoryEvolution.status(key));
  });
  app.post('/api/projects/:id/agent-memory/evolution', c => {
    const projectId = parseIdParam(c);
    if (!deps.db.getProject(projectId)) return notFound(c);
    const evolution = deps.memoryEvolution;
    const key = { scope: projectId === 0 ? 'user' as const : 'project' as const, projectId };
    if (!evolution) return c.json({ error: 'memory_evolution_unavailable' }, 503);
    if (!evolution.enabled(key)) return c.json({ error: 'memory_evolution_disabled' }, 409);
    void evolution.runOnce(key).catch(() => undefined);
    return c.json({ scheduled: true }, 202);
  });
}
