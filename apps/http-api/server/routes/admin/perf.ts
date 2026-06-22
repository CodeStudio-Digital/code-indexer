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
import { breakdownEnabled, breakdownSnapshot, resetBreakdown } from '../../perf/breakdown.js';
import { freezeSnapshot, resetFreezes, freezeThresholdMs } from '../../perf/freeze-log.js';
import { getElectronProfiler } from '../../perf/electron-profiler.js';
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
  // A fresh sample fans out to 3 worker-pool RPCs (2s timeout each), so two
  // panel polls landing close together each pay the full cost. Cache the
  // sample for a couple seconds — well under the panel's 10s poll, and the
  // 15s background sampler keeps history live regardless.
  const ttlRaw = Number(process.env.MCP_PERF_CURRENT_TTL_MS);
  const CURRENT_TTL_MS = Number.isFinite(ttlRaw) ? ttlRaw : 2500; // NaN-safe
  let currentCache: { sample: unknown; at: number } | null = null;

  app.get('/api/admin/perf/current', async (c) => {
    const sampler = getPerfSampler();
    if (!sampler) return c.json({ error: 'perf sampler not started' }, 503);
    if (currentCache && Date.now() - currentCache.at < CURRENT_TTL_MS) {
      return c.json(currentCache.sample);
    }
    const sample = await sampler.sampleNow();
    currentCache = { sample, at: Date.now() };
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
    resetBreakdown();
    return c.json({ ok: true });
  });

  // Per-handler time breakdown (git spawn vs disk vs SQL). Empty unless
  // MCP_PERF_BREAKDOWN=1 was set at boot — the wrappers are no-ops otherwise.
  app.get('/api/admin/perf/breakdown', (c) =>
    c.json({ enabled: breakdownEnabled(), rows: breakdownSnapshot() }),
  );

  // Main-loop freezes (real event-loop stalls), attributed to the in-flight
  // IPC handler. Renderer-side freezes (LoAF) are merged in the panel.
  app.get('/api/admin/perf/freezes', (c) =>
    c.json({ thresholdMs: freezeThresholdMs(), events: freezeSnapshot() }),
  );
  app.post('/api/admin/perf/freezes/reset', (c) => {
    resetFreezes();
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

  // ─── Full-app trace + renderer profile (Electron only) ───────────────
  // contentTracing records EVERY process/thread (main, renderers, GPU,
  // workers) into one Chromium-format trace for ui.perfetto.dev — the
  // JProfiler-style multi-thread timeline. 501 when not in Electron.
  app.post('/api/admin/perf/full-trace', async (c) => {
    const prof = getElectronProfiler();
    if (!prof) return c.json({ error: 'tracing unavailable (not running in Electron)' }, 501);
    let action: string | undefined;
    let durationMs = 10_000;
    try {
      const body = (await c.req.json()) as { action?: string; durationMs?: number };
      action = body.action;
      if (typeof body.durationMs === 'number') durationMs = body.durationMs;
    } catch { /* empty body — fixed-window default */ }
    try {
      if (action === 'start') { await prof.startFullTrace(); return c.json({ ok: true, tracing: true }); }
      if (action === 'stop') return c.json(await prof.stopFullTrace());
      durationMs = Math.min(60_000, Math.max(2_000, durationMs));
      return c.json(await prof.fullTrace(durationMs));
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 409);
    }
  });

  // Renderer-process V8 CPU profile (.cpuprofile) via the window's CDP
  // Profiler — fills the gap that node:inspector (main isolate) can't profile.
  app.post('/api/admin/perf/renderer-profile', async (c) => {
    const prof = getElectronProfiler();
    if (!prof) return c.json({ error: 'renderer profiling unavailable (not Electron)' }, 501);
    let durationMs = 10_000;
    try {
      const body = (await c.req.json()) as { durationMs?: number };
      if (typeof body.durationMs === 'number') durationMs = body.durationMs;
    } catch { /* empty body — default */ }
    durationMs = Math.min(30_000, Math.max(5_000, durationMs));
    try {
      return c.json(await prof.rendererProfile(durationMs));
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 409);
    }
  });
}
