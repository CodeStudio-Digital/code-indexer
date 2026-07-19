/**
 * Admin perf monitor routes — memory + profiling diagnostics.
 *
 *   GET  /api/admin/perf/current  — latest background sample (process tree,
 *                                   worker heaps, subsystem ledger, loop lag)
 *   GET  /api/admin/perf/history  — ring buffer (~60 min of points)
 *
 * The panel polls `current` every 5–10s. It serves the sampler's latest
 * background sample (refreshed on its own 15s tick) rather than forcing a
 * fresh collect — a fresh sample fans out to 3 worker-pool RPCs (2s timeout
 * each), which was both slow (~4s) AND parked the server loop in `await`,
 * surfacing as a phantom `starved` freeze every poll. ≤15s-stale numbers are
 * fine for a memory panel; only a cold open (before the first tick) pays once.
 *
 * Mounted by server.ts next to `mountWorkersDiagnosticRoute`.
 */
import type { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { getPerfSampler } from '../../perf/perf-sampler.js';
import { resetSlowCalls, slowCallsSnapshot } from '../../perf/slow-ipc.js';
import { breakdownEnabled, breakdownSnapshot, resetBreakdown } from '../../perf/breakdown.js';
import { freezeSnapshot, resetFreezes, freezeThresholdMs } from '../../perf/freeze-log.js';
import { getElectronProfiler } from '../../perf/electron-profiler.js';
import { captureCpuProfile, writeHeapSnapshotToTmp } from '../../perf/cpu-profile.js';
import {
  currentPersistentPerfRun,
  listPersistentPerfRuns,
  readPersistentPerfRun,
  recordPersistentRendererFreezes,
  type PersistedRendererFreeze,
} from '../../perf/persistent-diagnostics.js';
import { getWorkerOrchestratorPool } from '../../../sse/workerPoolSingleton.js';
import { getCoderWorkerPool } from '../../../sse/coderWorkerPoolSingleton.js';

/** Resolve the profile target: main isolate or one worker's isolate. */
async function captureCpuProfileFor(target: string, durationMs: number): Promise<object | null> {
  if (target === 'main') return captureCpuProfile(durationMs);
  const [kind, idRaw] = target.split(':');
  const sessionId = Number(idRaw);
  if (!Number.isFinite(sessionId)) throw new Error(`invalid target "${target}"`);
  if (kind === 'company') return getWorkerOrchestratorPool().cpuProfile(sessionId, durationMs);
  if (kind === 'coder') return getCoderWorkerPool().cpuProfile(sessionId, durationMs);
  throw new Error(`unknown target "${target}" (use main | company:<id> | coder:<id>)`);
}

function cleanRendererFreeze(value: unknown): PersistedRendererFreeze | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (typeof row.id !== 'string' || row.id.length < 1 || row.id.length > 240) return null;
  if (typeof row.at !== 'number' || !Number.isFinite(row.at) || row.at <= 0) return null;
  if (typeof row.durationMs !== 'number' || !Number.isFinite(row.durationMs) || row.durationMs < 0 || row.durationMs > 600_000) return null;
  if (row.kind !== 'loaf' && row.kind !== 'longtask') return null;
  const name = typeof row.name === 'string' ? row.name.slice(0, 2_000) : '';
  if (!name) return null;
  const script = typeof row.script === 'string' ? row.script.slice(0, 4_000) : undefined;
  return {
    id: row.id,
    at: Math.round(row.at),
    durationMs: Math.round(row.durationMs),
    name,
    script,
    kind: row.kind,
  };
}

const rendererFreezeBodyLimit = bodyLimit({
  maxSize: 512 * 1024,
  onError: (c) => c.json({ error: 'renderer freeze batch too large' }, 413),
});

export function mountPerfRoutes(app: Hono): void {
  app.get('/api/admin/perf/current', async (c) => {
    const sampler = getPerfSampler();
    if (!sampler) return c.json({ error: 'perf sampler not started' }, 503);
    // Serve the latest background sample (refreshed on the sampler's own 15s
    // tick) — cheap and never blocks the loop. Forcing a fresh `sampleNow()`
    // fans out to 3 worker-pool RPCs (2s timeout each ≈ 4s) and showed up both
    // as a slow IPC call AND a `starved` main-loop freeze (the loop parked in
    // await on every poll). Only a cold open before the first tick pays for one
    // `sampleNow()` so the panel isn't empty.
    const sample = sampler.getCurrent() ?? (await sampler.sampleNow());
    return c.json(sample);
  });

  app.get('/api/admin/perf/history', (c) => {
    const sampler = getPerfSampler();
    if (!sampler) return c.json({ error: 'perf sampler not started' }, 503);
    return c.json({ points: sampler.getHistory() });
  });

  // Crash-resilient per-run journal. The current run and the latest seven
  // runs are retained beside the configured app database.
  app.get('/api/admin/perf/runs', (c) =>
    c.json({ currentRunId: currentPersistentPerfRun()?.id ?? null, runs: listPersistentPerfRuns() }));

  app.get('/api/admin/perf/runs/:runId', async (c) => {
    const detail = await readPersistentPerfRun(c.req.param('runId'));
    return detail ? c.json(detail) : c.json({ error: 'performance run not found' }, 404);
  });

  // Renderer LoAFs are first staged in localStorage. If the app is force-killed
  // before this request succeeds, the next renderer launch retries them; the
  // journal resolves their original run from the event timestamp.
  app.post('/api/admin/perf/renderer-freezes', rendererFreezeBodyLimit, async (c) => {
    const body: { events?: unknown[]; runId?: unknown } = await c.req
      .json<{ events?: unknown[]; runId?: unknown }>()
      .catch(() => ({}));
    const rows = Array.isArray(body.events) ? body.events.slice(0, 50) : [];
    const requestedRunId = typeof body.runId === 'string' ? body.runId : undefined;
    const cleaned: PersistedRendererFreeze[] = [];
    for (const raw of rows) {
      const row = cleanRendererFreeze(raw);
      if (!row) continue;
      cleaned.push(row);
    }
    const persisted = recordPersistentRendererFreezes(cleaned, requestedRunId);
    return c.json({ ok: true, accepted: persisted, persisted, currentRunId: currentPersistentPerfRun()?.id ?? null });
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
