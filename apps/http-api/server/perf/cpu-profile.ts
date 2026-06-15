/**
 * On-demand V8 CPU profile + heap snapshot for the main process.
 *
 * CPU profile: `node:inspector` Session — Profiler.start, wait N seconds,
 * Profiler.stop → returns the `.cpuprofile` JSON (open in Chrome DevTools
 * Performance tab or VS Code). One profile at a time.
 *
 * Heap snapshot: `v8.writeHeapSnapshot()` to a temp dir — BLOCKS the main
 * thread for the duration (potentially tens of seconds on a multi-GB
 * heap) and writes a file roughly the size of the heap. The route never
 * streams the file; it returns the path for the user to open manually.
 */
import { Session } from 'node:inspector';
import v8 from 'node:v8';
import os from 'node:os';
import path from 'node:path';

let profiling = false;

export async function captureCpuProfile(durationMs: number): Promise<object> {
  if (profiling) throw new Error('CPU profile already in progress');
  profiling = true;
  const session = new Session();
  try {
    session.connect();
    const post = (method: string): Promise<unknown> =>
      new Promise((resolve, reject) =>
        session.post(method, (err, result) => (err ? reject(err) : resolve(result))),
      );
    await post('Profiler.enable');
    await post('Profiler.start');
    await new Promise((r) => setTimeout(r, durationMs));
    const { profile } = (await post('Profiler.stop')) as { profile: object };
    return profile;
  } finally {
    try { session.disconnect(); } catch { /* already gone */ }
    profiling = false;
  }
}

export function writeHeapSnapshotToTmp(): { path: string } {
  const file = path.join(
    os.tmpdir(),
    `codestudio-main-${process.pid}-${Date.now()}.heapsnapshot`,
  );
  const written = v8.writeHeapSnapshot(file);
  return { path: written };
}
