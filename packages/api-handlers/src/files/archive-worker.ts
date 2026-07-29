/**
 * Zip / unzip, off the main thread.
 *
 * WHY a worker: adm-zip is entirely synchronous — `addLocalFile` is a
 * `readFileSync` per member, `writeZip` deflates the whole archive into one
 * in-memory Buffer via `deflateRawSync` and writes it synchronously, and
 * `getData()` inflates synchronously. Running that on the Electron main process
 * froze EVERY window, all IPC, and every PTY stream for the duration of the
 * job. There is no async adm-zip API, so the fix is to move the blocking work
 * to a thread that is allowed to block. The process also exits when the job
 * ends, which hands the whole-archive Buffer straight back to the OS.
 *
 * WHY cancel travels on a SharedArrayBuffer and not `postMessage`: a worker
 * sitting inside synchronous adm-zip code never returns to its event loop, so
 * it never drains the message queue — a postMessage cancel would arrive only
 * after the work it was meant to abort had finished. `Atomics.load` on shared
 * memory is readable mid-loop, between members, without yielding.
 */
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { parentPort, workerData } from 'node:worker_threads';
import AdmZip from 'adm-zip';
import {
  ArchiveLimitError,
  DEFAULT_ARCHIVE_LIMITS,
  checkArchiveBudget,
  planExtract,
  type ArchiveLimits,
} from './archive-plan.js';

export interface ArchiveJob {
  kind: 'archive';
  /** Absolute paths to include; a directory goes in under its own basename. */
  roots: string[];
  /** Absolute path of the .zip to write. */
  out: string;
  limits?: ArchiveLimits;
}

export interface ExtractJob {
  kind: 'extract';
  /** Absolute path of the .zip to read. */
  zip: string;
  /** Absolute destination directory. */
  dest: string;
  limits?: ArchiveLimits;
}

export type ArchiveWorkerJob = ArchiveJob | ExtractJob;

export interface ArchiveWorkerData {
  job: ArchiveWorkerJob;
  /** Int32Array(1) over a SharedArrayBuffer; non-zero means "abort now". */
  cancel: SharedArrayBuffer;
}

export type ArchiveWorkerMessage =
  | { type: 'progress'; files: number; totalFiles: number; bytes: number; totalBytes: number }
  | { type: 'done'; files: number; bytes: number }
  | { type: 'error'; code: string; message: string }
  | { type: 'cancelled' };

const post = (m: ArchiveWorkerMessage): void => parentPort?.postMessage(m);

/** Emit at most ~20 frames/s regardless of how fast members are processed. */
function throttled(totalFiles: number, totalBytes: number) {
  let last = 0;
  return (files: number, bytes: number, force = false): void => {
    const now = Date.now();
    if (!force && now - last < 50) return;
    last = now;
    post({ type: 'progress', files, totalFiles, bytes, totalBytes });
  };
}

class CancelledError extends Error {
  constructor() {
    super('cancelled');
    this.name = 'CancelledError';
  }
}

/** Recursively collect files under `abs`, mapping each to its path inside the zip. */
async function collect(abs: string, prefix: string): Promise<Array<{ abs: string; entryName: string; size: number }>> {
  const st = await fs.stat(abs);
  if (!st.isDirectory()) return [{ abs, entryName: prefix, size: st.size }];
  const out: Array<{ abs: string; entryName: string; size: number }> = [];
  const entries = await fs.readdir(abs, { withFileTypes: true });
  for (const e of entries) {
    // Symlinks are not followed: a link pointing outside the tree would pull in
    // arbitrary files, and a cycle would never terminate.
    if (e.isSymbolicLink()) continue;
    out.push(...(await collect(path.join(abs, e.name), `${prefix}/${e.name}`)));
  }
  return out;
}

async function runArchive(job: ArchiveJob, cancelled: () => boolean): Promise<{ files: number; bytes: number }> {
  const members: Array<{ abs: string; entryName: string; size: number }> = [];
  for (const root of job.roots) {
    if (cancelled()) throw new CancelledError();
    members.push(...(await collect(root, path.basename(root))));
  }
  // Budget BEFORE reading a single byte into memory.
  const budget = checkArchiveBudget(members, job.limits ?? DEFAULT_ARCHIVE_LIMITS);
  const emit = throttled(budget.files, budget.bytes);

  const zip = new AdmZip();
  let files = 0;
  let bytes = 0;
  for (const m of members) {
    if (cancelled()) throw new CancelledError();
    // addFile (not addLocalFile) so the in-zip path is ours, not derived from
    // the absolute path on disk.
    zip.addFile(m.entryName, await fs.readFile(m.abs));
    files += 1;
    bytes += m.size;
    emit(files, bytes);
  }
  if (cancelled()) throw new CancelledError();
  await fs.mkdir(path.dirname(job.out), { recursive: true });
  zip.writeZip(job.out);
  emit(files, bytes, true);
  return { files, bytes };
}

async function runExtract(job: ExtractJob, cancelled: () => boolean): Promise<{ files: number; bytes: number }> {
  let archive: AdmZip;
  try {
    archive = new AdmZip(job.zip);
  } catch {
    throw new ArchiveLimitError('bad_archive', 'not a readable zip archive');
  }
  // Sizes come from the central directory — nothing is inflated yet.
  const { members, budget } = planExtract(
    archive.getEntries().map((e) => ({
      entryName: e.entryName,
      isDirectory: e.isDirectory,
      size: e.header.size,
      compressedSize: e.header.compressedSize,
    })),
    job.limits ?? DEFAULT_ARCHIVE_LIMITS,
  );
  const emit = throttled(budget.files, budget.bytes);

  await fs.mkdir(job.dest, { recursive: true });
  const byName = new Map(archive.getEntries().map((e) => [e.entryName, e]));
  let files = 0;
  let bytes = 0;
  for (const m of members) {
    if (cancelled()) throw new CancelledError();
    const entry = byName.get(m.entryName);
    if (!entry) continue;
    const target = path.join(job.dest, m.safeName);
    await fs.mkdir(path.dirname(target), { recursive: true });
    const data = entry.getData();
    await fs.writeFile(target, data);
    files += 1;
    bytes += data.length;
    emit(files, bytes);
  }
  emit(files, bytes, true);
  return { files, bytes };
}

async function main(): Promise<void> {
  const { job, cancel } = workerData as ArchiveWorkerData;
  const flag = new Int32Array(cancel);
  const cancelled = (): boolean => Atomics.load(flag, 0) !== 0;
  try {
    const result = job.kind === 'archive' ? await runArchive(job, cancelled) : await runExtract(job, cancelled);
    post({ type: 'done', ...result });
  } catch (err) {
    if (err instanceof CancelledError) {
      post({ type: 'cancelled' });
      return;
    }
    const code = err instanceof ArchiveLimitError ? err.code : 'archive_failed';
    post({ type: 'error', code, message: err instanceof Error ? err.message : String(err) });
  }
}

void main();
