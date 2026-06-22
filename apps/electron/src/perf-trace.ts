/**
 * Electron-main profiling: the two capabilities the in-process http-api can't
 * reach because they live behind `electron` imports.
 *
 *  1. Full-app trace via `contentTracing` — records EVERY process/thread (main,
 *     each renderer, GPU, utility, V8 isolates) into one Chromium-format trace
 *     loadable in https://ui.perfetto.dev or chrome://tracing. This is the
 *     closest thing to a JProfiler-style multi-thread timeline for the app.
 *  2. Renderer CPU profile via the window's CDP `Profiler` domain — a
 *     `.cpuprofile` for the UI thread (which `node:inspector` in the main
 *     process can't see), openable in Chrome DevTools → Performance.
 *
 * Registered into the http-api perf singleton at boot so the existing
 * `/api/admin/perf/*` routes drive it.
 */
import { contentTracing, BrowserWindow } from 'electron';
import type { ElectronProfiler } from '@apps/http-api/server/perf/electron-profiler.js';

// Categories tuned for FREEZE diagnosis: top-level tasks + V8 (with the
// disabled-by-default CPU profiler for JS stacks) + Blink/compositor + input
// latency + the scheduler queue. Enough to see which thread blocked and on
// what, without an unmanageably huge trace.
const TRACE_CATEGORIES = [
  'toplevel',
  'v8',
  'v8.execute',
  'disabled-by-default-v8.cpu_profiler',
  'blink',
  'cc',
  'gpu',
  'latencyInfo',
  'sequence_manager',
  'disabled-by-default-toplevel.flow',
];

let tracing = false;

// Pick a real APP window (tagged by createAppWindow in main.ts) — never a
// preview/inspect or splash window, which are also focusable top-level
// BrowserWindows and would otherwise profile the wrong renderer.
function isAppWindow(w: BrowserWindow): boolean {
  return !w.isDestroyed() && (w as unknown as { __mcpAppWindow?: boolean }).__mcpAppWindow === true;
}

function targetWindow(): BrowserWindow | null {
  const focused = BrowserWindow.getFocusedWindow();
  if (focused && isAppWindow(focused)) return focused;
  return BrowserWindow.getAllWindows().find(isAppWindow) ?? null;
}

async function startFullTrace(): Promise<void> {
  // contentTracing has ONE process-global recorder — refuse to start a second
  // so a fixed-window capture can't silently stop a manual session (and vice
  // versa). The route maps the throw to a 409.
  if (tracing) throw new Error('a trace is already in progress');
  await contentTracing.startRecording({
    // Ring buffer: keep the MOST RECENT events so a freeze at the end of the
    // window survives instead of being dropped once a fixed buffer fills.
    recording_mode: 'record-continuously',
    trace_buffer_size_in_kb: 300_000,
    included_categories: TRACE_CATEGORIES,
  });
  tracing = true;
}

async function stopFullTrace(): Promise<{ path: string }> {
  if (!tracing) throw new Error('no trace in progress');
  try {
    // No path arg → Electron writes to a temp file and resolves its path.
    return { path: await contentTracing.stopRecording() };
  } finally {
    // Clear even if stopRecording rejects (disk-full / flush failure) so the
    // recorder isn't wedged "tracing" until an app restart.
    tracing = false;
  }
}

async function fullTrace(durationMs: number): Promise<{ path: string }> {
  await startFullTrace();
  await new Promise((r) => setTimeout(r, durationMs));
  return stopFullTrace();
}

async function rendererProfile(durationMs: number): Promise<object> {
  const win = targetWindow();
  if (!win) throw new Error('no renderer window to profile');
  const dbg = win.webContents.debugger;
  let attachedHere = false;
  if (!dbg.isAttached()) {
    dbg.attach('1.3');
    attachedHere = true;
  }
  try {
    await dbg.sendCommand('Profiler.enable');
    await dbg.sendCommand('Profiler.start');
    await new Promise((r) => setTimeout(r, durationMs));
    const { profile } = (await dbg.sendCommand('Profiler.stop')) as { profile: object };
    return profile;
  } finally {
    try { await dbg.sendCommand('Profiler.disable'); } catch { /* ignore */ }
    // Only detach if WE attached — never yank a debugger the user opened.
    if (attachedHere) {
      try { dbg.detach(); } catch { /* already gone */ }
    }
  }
}

export function createElectronProfiler(): ElectronProfiler {
  return {
    startFullTrace,
    stopFullTrace,
    fullTrace,
    isTracing: () => tracing,
    rendererProfile,
  };
}
