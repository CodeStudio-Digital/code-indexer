/**
 * Task-manager routes — the live process tree behind the Shift+Esc window.
 *
 *   GET  /api/admin/processes       — one snapshot of every process the app owns
 *   POST /api/admin/processes/kill  — end one task, guarded
 *
 * Deliberately NOT folded into `/api/admin/perf/current`: that endpoint serves
 * a deliberately stale background sample because forcing a fresh one fans out
 * to three worker-pool RPCs (~4s) and parked the main event loop on every
 * poll, which surfaced as a phantom `starved` freeze. This handler is fully
 * synchronous — it reads a frame the collector already assembled and never
 * awaits a worker — so it stays pollable at 1-2s.
 */
import type { Hono } from 'hono';
import {
  buildProcessSnapshot,
  type ProcessSnapshotSources,
} from '../../perf/census/snapshot.js';
import { evaluateKill } from '../../perf/census/kill-guard.js';
import { executeKill, type KillMode } from '../../perf/census/kill-executor.js';

type ProcessRoutesDeps = ProcessSnapshotSources;

const DEFAULT_INTERVAL_MS = 2_000;

export function mountProcessRoutes(app: Hono, deps: ProcessRoutesDeps): void {
  app.get('/api/admin/processes', (c) => {
    const intervalMs = Number(c.req.query('intervalMs')) || DEFAULT_INTERVAL_MS;
    const snapshot = buildProcessSnapshot(deps, intervalMs);
    return c.json({
      at: snapshot.at,
      mainPid: snapshot.mainPid,
      cores: snapshot.cores,
      status: snapshot.status,
      rows: snapshot.rows,
      totals: snapshot.totals,
    });
  });

  app.post('/api/admin/processes/kill', async (c) => {
    const body = await c.req
      .json<{ pid?: unknown; mode?: unknown }>()
      .catch(() => ({} as { pid?: unknown; mode?: unknown }));
    const pid = typeof body.pid === 'number' ? body.pid : Number.NaN;
    const mode: KillMode = body.mode === 'force' ? 'force' : 'graceful';

    // Re-derive the tree rather than trusting a pid the renderer sent: the
    // guard must judge the process table as it is now, not as the client last
    // saw it. No interval is passed — this read must not disturb the rate the
    // polling loop set up.
    const snapshot = buildProcessSnapshot(deps);
    const verdict = evaluateKill(pid, snapshot.killContext);
    if (!verdict.ok) {
      return c.json({ error: verdict.code, code: verdict.code }, verdict.status);
    }

    try {
      const method = await executeKill(pid, mode, snapshot.owners.get(pid));
      return c.json({ ok: true, pid, method });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
    }
  });
}
