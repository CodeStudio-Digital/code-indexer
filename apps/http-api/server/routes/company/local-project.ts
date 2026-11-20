/**
 * Local-project routes — host-process runner for projects detected by
 * their manifest (`package.json`, `pyproject.toml`, `go.mod`,
 * `Cargo.toml`, `Gemfile`). Sibling of `/services` but runs outside
 * any container.
 *
 * Endpoints:
 *   POST    /api/company/sessions/:id/local-project   start / restart
 *   GET     /api/company/sessions/:id/local-project   status
 *   DELETE  /api/company/sessions/:id/local-project   stop
 *
 * Security posture — because the process runs on the host as the same
 * UID as the server, every input passes through three gates:
 *   1. Path must be absolute and live under a registered project's
 *      `root_path` (so users can't point at `C:\Windows` or `/etc`).
 *   2. Manifest must be detected — we don't spawn arbitrary dirs.
 *   3. The synthesized (or fallback) argv is re-validated through the
 *      allowlist before `spawn()` — AI output is never trusted.
 */

import type { HttpRouter } from '@mcp/shared/http/router.js';
import type { ServerDeps } from '../../deps.js';
import {
  parseCompanySessionIdParam,
  notFound,
  resolveRootSessionId,
} from '../_helpers.js';
import { getLocalProcessManager } from '@mcp/services/sandbox/local-process/LocalProcessManager.js';

export function mountCompanyLocalProjectRoutes(app: HttpRouter, deps: ServerDeps): void {
  const { sessionStore, companyLocalProjectStore } = deps;

  // GET status — used by the UI to render the "host" row in the sidebar.
  app.get('/api/company/sessions/:id/local-project', async (c) => {
    const id = await resolveRootSessionId(
      sessionStore,
      parseCompanySessionIdParam(c),
    );
    if (!id) return notFound(c);
    const live = getLocalProcessManager().get(id);
    if (live) {
      return c.json({
        session_id: id,
        cwd: live.cwd,
        manifest_kind: live.manifestKind,
        program: live.program,
        args: live.args,
        host_port: live.hostPort,
        status: live.status,
        preview_url: live.previewUrl,
        pid: live.pid,
        rationale: live.rationale,
        synth_source: live.synthSource,
        error: live.error ?? null,
        source: 'live',
      });
    }
    // Nothing live — fall back to the persisted row (maybe destroyed
    // by server-restart; the UI uses this to show a Retry affordance).
    const row = companyLocalProjectStore.get(id);
    if (!row) return c.json({ session_id: id, status: 'none' });
    return c.json({
      session_id: id,
      cwd: row.cwd,
      manifest_kind: row.manifest_kind,
      program: row.program,
      args: JSON.parse(row.args_json) as string[],
      host_port: row.host_port,
      status: row.status,
      preview_url: null,
      pid: row.pid,
      rationale: row.rationale,
      synth_source: row.synth_source,
      error: row.error,
      source: 'persisted',
    });
  });

  // POST — start (or restart after stop) a local-process run.
  app.post('/api/company/sessions/:id/local-project', async (c) => {
    parseCompanySessionIdParam(c);
    return c.json(
      {
        error:
          'Run local project (host process) has been retired. Use External project so the project runs in a container with the Node dev image or its Dockerfile.',
      },
      410,
    );
  });

  // DELETE — stop a running local project AND drop the persisted row.
  //
  // Two scenarios merged into one handler:
  //   a) Live process: SIGTERM → SIGKILL, release port, mark destroyed.
  //      The manager already handles this via `stop()`.
  //   b) Orphaned row (server restart, spawn error): nothing is live,
  //      but the DB row survives so the UI keeps showing it as
  //      'orphaned'. A user-initiated DELETE is the only path that
  //      hard-deletes — otherwise the row could never be cleared.
  app.delete('/api/company/sessions/:id/local-project', async (c) => {
    const id = await resolveRootSessionId(
      sessionStore,
      parseCompanySessionIdParam(c),
    );
    if (!id) return notFound(c);
    await getLocalProcessManager().stop(id, 'user-stopped');
    companyLocalProjectStore.delete(id);
    return c.json({ ok: true });
  });
}
