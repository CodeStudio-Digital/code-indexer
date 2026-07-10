import type { Hono } from 'hono';
import { auditAppArchitecture } from '@mcp/app-studio/architecture/audit.js';
import { parseAppArchitecturePlan } from '@mcp/app-studio/architecture/types.js';
import { parseAppSpec } from '@mcp/app-studio/spec/types.js';
import { notFound, parseIdParam } from '../_helpers.js';
import type { ServerDeps } from '../../deps.js';

export function mountAppStudioArchitectureRoutes(app: Hono, deps: ServerDeps): void {
  app.get('/api/app-studio/sessions/:id/architecture', (c) => {
    const id = parseIdParam(c);
    const session = deps.appStudioStore.getSession(id);
    if (!session) return notFound(c);
    const spec = parseAppSpec(session.spec_json);
    return c.json({
      revisions: deps.appStudioStore.listArchitectureRevisions(id).map((revision) => {
        const plan = parseAppArchitecturePlan(revision.architecture_json);
        return {
          ...revision,
          architecture_json: undefined,
          plan,
          audit: auditAppArchitecture(plan, spec),
        };
      }),
    });
  });
}
