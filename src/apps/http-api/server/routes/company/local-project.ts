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

import type { Hono } from 'hono';
import { isAbsolute, resolve as resolvePath, sep as pathSep } from 'node:path';
import type { ServerDeps } from '../../deps.js';
import { parseIdParam, parseJsonBody, notFound } from '../_helpers.js';
import { detectManifest } from '../../../../../core/sandbox/manifest-detector/detect.js';
import { synthesizeStartCommand } from '../../../../../core/sandbox/command-synth/synthesize.js';
import { validateArgv } from '../../../../../core/sandbox/command-synth/allowlist.js';
import { defaultPortAllocator } from '../../../../../core/sandbox/port-allocator.js';
import { getLocalProcessManager } from '../../../../../core/sandbox/local-process/LocalProcessManager.js';

interface StartBody {
  path?: string;
  useAi?: boolean;
}

export function mountCompanyLocalProjectRoutes(app: Hono, deps: ServerDeps): void {
  const { companyStore, db, companyLocalProjectStore } = deps;

  // GET status — used by the UI to render the "host" row in the sidebar.
  app.get('/api/company/sessions/:id/local-project', (c) => {
    const id = parseIdParam(c);
    const session = companyStore.getCompanySession(id);
    if (!session) return notFound(c);
    const live = getLocalProcessManager().get(String(id));
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
    const id = parseIdParam(c);
    const session = companyStore.getCompanySession(id);
    if (!session) return notFound(c);

    const body = await parseJsonBody<StartBody>(c);
    const rawPath = typeof body.path === 'string' ? body.path.trim() : '';
    if (!rawPath) return c.json({ error: 'path is required' }, 400);
    if (!isAbsolute(rawPath)) {
      return c.json({ error: 'path must be absolute' }, 400);
    }
    const absPath = resolvePath(rawPath);

    // Gate 1 — path must live under a known project root. This is the
    // primary defense against running arbitrary host directories.
    const roots = db.listProjects().map((p) => resolvePath(p.root_path));
    const underKnownRoot = roots.some((root) => isPathUnder(absPath, root));
    if (!underKnownRoot) {
      return c.json(
        {
          error:
            'path must be equal to or under a registered project root. ' +
            'Open the Projects page first and add this folder.',
        },
        400,
      );
    }

    // Gate 2 — manifest must be detected.
    const manifest = detectManifest(absPath);
    if (!manifest) {
      return c.json(
        {
          error:
            'no supported manifest in this folder (package.json, pyproject.toml, ' +
            'go.mod, Cargo.toml, Gemfile)',
        },
        400,
      );
    }

    // If a live process is already running, return 409 — user must stop first.
    const mgr = getLocalProcessManager();
    if (mgr.get(String(id))) {
      return c.json({ error: 'a local project is already running; stop it first' }, 409);
    }

    const allocator = defaultPortAllocator();
    const port = await allocator.acquire();

    let synthesis;
    try {
      synthesis = await synthesizeStartCommand(manifest, port, {
        useAi: body.useAi === true,
      });
    } catch (err) {
      allocator.release(port);
      throw err;
    }

    // Gate 3 — the synthesized argv passes the same allowlist used by
    // the manager. Fallback rules already pass by construction; AI
    // output is checked inside `synthesizeStartCommand` but we re-validate
    // here too so a future bug in the synth layer can't sneak through.
    const argvCheck = validateArgv(synthesis.command.program, synthesis.command.args);
    if (!argvCheck.ok) {
      allocator.release(port);
      return c.json({ error: `rejected: ${argvCheck.reason}` }, 422);
    }

    // Release the allocator's pre-acquired port so the manager's own
    // `acquire()` can take it (the manager owns the allocation lifecycle).
    allocator.release(port);

    try {
      const result = await mgr.start({
        sessionId: String(id),
        cwd: absPath,
        manifestKind: manifest.kind,
        program: synthesis.command.program,
        args: synthesis.command.args,
        env: synthesis.command.env,
        rationale: synthesis.command.rationale,
        synthSource: synthesis.source,
        readyProbePath: synthesis.command.readyProbe.path,
      });
      return c.json({
        preview_url: result.previewUrl,
        port: result.hostPort,
        pid: result.pid,
        program: result.program,
        args: result.args,
        rationale: synthesis.command.rationale,
        synth_source: synthesis.source,
        ai_failure_reason: synthesis.aiFailureReason ?? null,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const code = (err as { code?: string } | null)?.code;
      const status = code === 'READINESS_FAILED' ? 424 : 500;
      return c.json({ error: message, code: code ?? null }, status);
    }
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
    const id = parseIdParam(c);
    const session = companyStore.getCompanySession(id);
    if (!session) return notFound(c);
    await getLocalProcessManager().stop(String(id), 'user-stopped');
    companyLocalProjectStore.delete(id);
    return c.json({ ok: true });
  });
}

/**
 * True when `candidate` is equal to `root` or lives inside it. Uses
 * path-separator-aware prefix check after resolution to defeat
 * `/foo/../etc` shenanigans.
 */
function isPathUnder(candidate: string, root: string): boolean {
  const normCandidate = candidate.endsWith(pathSep) ? candidate : candidate + pathSep;
  const normRoot = root.endsWith(pathSep) ? root : root + pathSep;
  return (
    candidate === root ||
    normCandidate.toLowerCase().startsWith(normRoot.toLowerCase())
  );
}
