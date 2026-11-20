/** Preview plans come from durable run criteria; legacy Playwright plans stay
 * readable in their own service workspace. Opening this view never provisions
 * a sandbox or initializes a container driver. */
import type { HttpRouter, HttpContext } from '@mcp/shared/http/router.js';
import type { ServerDeps } from '../../../deps.js';
import { notFound, parseCompanySessionIdParam, parseJsonBody, resolveCompanySessionContext } from '../../_helpers.js';
import { tryGetSandboxManager } from '@mcp/services/sandbox/index.js';
import type { QaTestPlan } from '@mcp/services/qa/types.js';

const TEST_PLAN_PATH = 'tests/e2e/TEST_PLAN.md';
const MAX_BODY_BYTES = 200 * 1024;
const emptyPlan: QaTestPlan = { exists: false, content: '', source: 'none' };
function serviceId(c: HttpContext): string | null {
  const id = c.req.query('service') || 'main';
  return /^[a-zA-Z0-9_-]{1,64}$/.test(id) ? id : null;
}

export function mountQaTestPlanRoutes(app: HttpRouter, deps: ServerDeps): void {
  app.get('/api/company/sessions/:id/qa/test-plan', async c => {
    const id = parseCompanySessionIdParam(c);
    if (!await resolveCompanySessionContext(deps.sessionStore, id)) return notFound(c);
    const service = serviceId(c);
    if (!service) return c.json({ error: 'invalid service_id' }, 400);
    const [run] = await deps.qaTestRunStore.listRuns({ company_session_id: id, service_id: service, limit: 1 });
    if (run?.executor === 'preview' && run.criteria?.length) {
      const plan: QaTestPlan = { exists: true, source: 'preview', run_id: run.id, title: run.suite,
        target_url: run.target_url, criteria: run.criteria,
        content: '## ' + run.suite + '\n\n' + run.criteria.map(criterion => '- ' + criterion.name).join('\n') };
      return c.json(plan);
    }
    const manager = tryGetSandboxManager();
    const sandbox = service === 'main' ? manager?.get(id) : manager?.getService(id, service);
    if (!manager || !sandbox) return c.json(emptyPlan);
    try {
      const content = await manager.readWorkspaceFileOnService(id, service, TEST_PLAN_PATH);
      const plan: QaTestPlan = content == null ? emptyPlan : { exists: true, content, source: 'sandbox', run_id: run?.id };
      return c.json(plan);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/no sandbox/i.test(message)) return c.json(emptyPlan);
      return c.json({ error: message }, 500);
    }
  });

  app.put('/api/company/sessions/:id/qa/test-plan', async c => {
    const id = parseCompanySessionIdParam(c);
    if (!await resolveCompanySessionContext(deps.sessionStore, id)) return notFound(c);
    const service = serviceId(c);
    if (!service) return c.json({ error: 'invalid service_id' }, 400);
    const body = await parseJsonBody<{ content: string }>(c);
    if (typeof body?.content !== 'string') return c.json({ error: 'body.content must be a string' }, 400);
    if (Buffer.byteLength(body.content, 'utf8') > MAX_BODY_BYTES) return c.json({ error: 'body too large (>' + MAX_BODY_BYTES + ' bytes)' }, 413);
    const manager = tryGetSandboxManager();
    const sandbox = service === 'main' ? manager?.get(id) : manager?.getService(id, service);
    if (!manager || !sandbox) return c.json({ error: 'session has no sandbox' }, 409);
    try {
      await manager.writeWorkspaceFileOnService(id, service, TEST_PLAN_PATH, body.content);
      return c.json({ ok: true });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/no sandbox/i.test(message)) return c.json({ error: 'session has no sandbox' }, 409);
      return c.json({ error: message }, 500);
    }
  });
}
