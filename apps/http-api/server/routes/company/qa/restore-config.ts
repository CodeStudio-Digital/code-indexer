/**
 * `POST /api/company/sessions/:id/qa/restore-config` — operator-driven
 * one-click recovery for the MCP-managed QA workspace artifacts.
 *
 * Backs the "Restore QA config" button on Tab Testes. Equivalent to
 * what `qa_start_run` does on the agent path (force-restore reporter
 * + global-setup, validate `playwright.config.ts`, write `.recommended`
 * sibling on drift) — minus the `tests/e2e/.mcp-qa-run.json` write,
 * which only makes sense when there's a run id to bind to.
 *
 * No request body required; returns the `WorkspaceRestoreReport` so the
 * UI can render ✓/⚠ feedback without a second roundtrip.
 */
import type { Hono } from 'hono';
import type { ServerDeps } from '../../../deps.js';
import { parseSessionIdParam } from '../../_helpers.js';
import { tryGetSandboxManager } from '@mcp/services/sandbox/index.js';
import { restoreQaWorkspace } from '@mcp/services/qa/workspace-restore.js';

export function mountQaRestoreConfigRoute(app: Hono, deps: ServerDeps): void {
  void deps; // SandboxManager is the only dependency, accessed as a singleton.

  app.post('/api/company/sessions/:id/qa/restore-config', async (c) => {
    const sessionId = parseSessionIdParam(c);
    const manager = tryGetSandboxManager();
    if (!manager?.get(sessionId)) {
      return c.json({ ok: false, error: 'no-sandbox', message: 'Sandbox not provisioned for this session yet.' }, 409);
    }
    try {
      // Operator-triggered: don't wipe test-results / playwright-report
      // out from under them. v4.5 retention is only run from
      // `qa_start_run`, where the wipe is part of preparing a NEW run.
      const report = await restoreQaWorkspace(manager, {
        sessionId,
        pruneArtifacts: false,
      });
      return c.json({ ok: true, report });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // No-sandbox is the common cause when the operator clicks the
      // button before provisioning the project. Surface it cleanly so
      // the UI can render a friendly hint instead of a 500.
      if (/no sandbox/i.test(msg)) {
        return c.json(
          { ok: false, error: 'no-sandbox', message: 'Sandbox not provisioned for this session yet.' },
          409,
        );
      }
      return c.json({ ok: false, error: 'restore-failed', message: msg }, 500);
    }
  });
}
