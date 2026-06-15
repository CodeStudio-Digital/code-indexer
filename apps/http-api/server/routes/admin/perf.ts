/**
 * Admin perf monitor routes — memory + profiling diagnostics.
 *
 *   GET  /api/admin/perf/current  — fresh sample (process tree, worker
 *                                   heaps, subsystem ledger, loop lag)
 *   GET  /api/admin/perf/history  — ring buffer (~60 min of points)
 *
 * The panel polls `current` every 5–10s; that call forces a fresh sample
 * so the user always sees live numbers, while the sampler's own 15s tick
 * keeps the history populated even with the panel closed.
 *
 * Mounted by server.ts next to `mountWorkersDiagnosticRoute`.
 */
import type { Hono } from 'hono';
import { getPerfSampler } from '../../perf/perf-sampler.js';
import { resetSlowCalls, slowCallsSnapshot } from '../../perf/slow-ipc.js';
import { captureCpuProfile, writeHeapSnapshotToTmp } from '../../perf/cpu-profile.js';
import { getWorkerOrchestratorPool } from '../../../sse/workerPoolSingleton.js';
import { coderWorkerEnabled, getCoderWorkerPool } from '../../../sse/coderWorkerPoolSingleton.js';

/** Resolve the profile target: main isolate or one worker's isolate. */
async function captureCpuProfileFor(target: string, durationMs: number): Promise<object | null> {
  if (target === 'main') return captureCpuProfile(durationMs);
  const [kind, idRaw] = target.split(':');
  const sessionId = Number(idRaw);
  if (!Number.isFinite(sessionId)) throw new Error(`invalid target "${target}"`);
  if (kind === 'company') return getWorkerOrchestratorPool().cpuProfile(sessionId, durationMs);
  if (kind === 'coder' && coderWorkerEnabled()) return getCoderWorkerPool().cpuProfile(sessionId, durationMs);
  throw new Error(`unknown target "${target}" (use main | company:<id> | coder:<id>)`);
}

export function mountPerfRoutes(app: Hono): void {
  app.get('/api/admin/perf/current', async (c) => {
    const sampler = getPerfSampler();
    if (!sampler) return c.json({ error: 'perf sampler not started' }, 503);
    const sample = await sampler.sampleNow();
    return c.json(sample);
  });

  app.get('/api/admin/perf/history', (c) => {
    const sampler = getPerfSampler();
    if (!sampler) return c.json({ error: 'perf sampler not started' }, 503);
    return c.json({ points: sampler.getHistory() });
  });

  // ─── Profiling tools (Fase 2) ────────────────────────────────────

  app.get('/api/admin/perf/slow-ipc', (c) => c.json({ rows: slowCallsSnapshot() }));
  app.post('/api/admin/perf/slow-ipc/reset', (c) => {
    resetSlowCalls();
    return c.json({ ok: true });
  });

  // V8 CPU profile — body { durationMs, target } with durationMs clamped
  // to 5–30s and target one of `main` (default — the whole in-process
  // backend), `company:<sessionId>` or `coder:<sessionId>` (one worker's
  // isolate). Returns the .cpuprofile JSON; the panel downloads it as a
  // file for Chrome DevTools. Worker targets are also curl-able like
  // /api/admin/workers.
  app.post('/api/admin/perf/cpu-profile', async (c) => {
    let durationMs = 10_000;
    let target = 'main';
    try {
      const body = (await c.req.json()) as { durationMs?: number; target?: string };
      if (typeof body.durationMs === 'number') durationMs = body.durationMs;
      if (typeof body.target === 'string') target = body.target;
    } catch { /* empty body — defaults */ }
    durationMs = Math.min(30_000, Math.max(5_000, durationMs));
    try {
      const profile = await captureCpuProfileFor(target, durationMs);
      if (!profile) return c.json({ error: `no active worker for target "${target}"` }, 404);
      return c.json(profile);
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 409);
    }
  });

  // Heap snapshot — BLOCKS the main thread while writing (the panel shows
  // a confirm dialog). Returns the file path; never streamed over IPC.
  app.post('/api/admin/perf/heap-snapshot', (c) => {
    try {
      const { path } = writeHeapSnapshotToTmp();
      return c.json({ path });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
    }
  });
}
