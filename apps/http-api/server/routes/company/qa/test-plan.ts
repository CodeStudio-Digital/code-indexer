/**
 * Test plan routes — read and write `tests/e2e/TEST_PLAN.md` from inside
 * the company session's sandbox container. Lets the dashboard's
 * TestPlanView render the plan and a future inline editor save edits
 * back without leaving the UI.
 *
 * The QA agent already manages this file via `read_file`/`write_file`
 * tools; these endpoints exist purely so the human-in-the-loop has a
 * direct surface, and so the dashboard renders the canonical contents
 * (parsed once via the pure `parseTestPlanSections`).
 *
 * Path is hard-coded; the routes don't accept arbitrary file paths to
 * avoid path-traversal headaches. The validation lives in
 * `SandboxManager.readWorkspaceFile` regardless.
 */
import type { Hono } from 'hono';
import type { ServerDeps } from '../../../deps.js';
import { parseIdParam, parseJsonBody } from '../../_helpers.js';
import { getSandboxManager } from '@mcp/services/sandbox/index.js';

const TEST_PLAN_PATH = 'tests/e2e/TEST_PLAN.md';
const MAX_BODY_BYTES = 200 * 1024;

interface PutBody {
  content: string;
}

export function mountQaTestPlanRoutes(app: Hono, deps: ServerDeps): void {
  void deps; // No store deps — manager is module-level.

  app.get('/api/company/sessions/:id/qa/test-plan', async (c) => {
    const sessionId = parseIdParam(c);
    try {
      const content = await getSandboxManager().readWorkspaceFile(
        String(sessionId),
        TEST_PLAN_PATH,
      );
      return c.json({ exists: content !== null, content: content ?? '' });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // No-sandbox is the common case for non-builder sessions — return
      // 200 with `exists:false` so the UI renders an empty placeholder
      // instead of an error toast.
      if (/no sandbox/i.test(msg)) return c.json({ exists: false, content: '' });
      return c.json({ error: msg }, 500);
    }
  });

  app.put('/api/company/sessions/:id/qa/test-plan', async (c) => {
    const sessionId = parseIdParam(c);
    const body = await parseJsonBody<PutBody>(c);
    if (typeof body.content !== 'string') {
      return c.json({ error: 'body.content must be a string' }, 400);
    }
    if (body.content.length > MAX_BODY_BYTES) {
      return c.json({ error: `body too large (>${MAX_BODY_BYTES} bytes)` }, 413);
    }
    try {
      await getSandboxManager().writeWorkspaceFile(
        String(sessionId),
        TEST_PLAN_PATH,
        body.content,
      );
      return c.json({ ok: true });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (/no sandbox/i.test(msg)) return c.json({ error: 'session has no sandbox' }, 409);
      return c.json({ error: msg }, 500);
    }
  });
}
