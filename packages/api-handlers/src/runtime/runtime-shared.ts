/**
 * Shared scaffolding for runtime managers (node/php/python). Holds the
 * managed-install root layout and a generic download+extract generator so
 * each kind's manager doesn't re-implement streaming/IO. Detection-side
 * helpers (PATH probing, version folder scans) stay in detect-*.ts.
 */

import { execFile } from 'node:child_process';
import { createHash, type Hash } from 'node:crypto';
import { createWriteStream, type WriteStream } from 'node:fs';
import { mkdir, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { extractZipToDir } from '@mcp/design-system/extract-zip.js';
import type { InstallProgress, RuntimeKind } from '@mcp/api-bus';
import { assertRuntimeVersion } from './runtime-version.js';

const execFileAsync = promisify(execFile);

export interface DownloadDigest {
  algorithm: 'sha256' | 'sha512';
  expected: string;
}

/** Managed installs live under `<dataDir>/<kind>/...` (e.g. `<dataDir>/php/8.3.7/`). */
export function managedRuntimeRoot(dataDir: string, kind: RuntimeKind): string {
  return join(dataDir, kind);
}

/**
 * Write one chunk, awaiting `drain` on backpressure but REJECTING on a stream
 * error so a failed write (ENOSPC / EACCES / AV lock) can never park the
 * download forever waiting for a `drain` that will never fire.
 */
function writeChunk(out: WriteStream, chunk: Uint8Array): Promise<void> {
  return new Promise((resolve, reject) => {
    const ok = out.write(chunk, (err) => { if (err) reject(err); });
    if (ok) { resolve(); return; }
    const cleanup = (): void => { out.off('drain', onDrain); out.off('error', onError); };
    const onDrain = (): void => { cleanup(); resolve(); };
    const onError = (e: Error): void => { cleanup(); reject(e); };
    out.once('drain', onDrain);
    out.once('error', onError);
  });
}

/** Flush + close the stream; rejects on error, never hangs on a destroyed stream. */
function finishWrite(out: WriteStream): Promise<void> {
  return new Promise((resolve, reject) => {
    out.once('error', reject);
    out.end(() => resolve());
  });
}

/**
 * Pump a fetch body into an open write stream, yielding byte progress. Throws
 * on any network OR write error and destroys the stream on the way out (no
 * uncaught 'error', no deadlock). The caller owns the file path's cleanup.
 */
async function* streamToFile(
  body: AsyncIterable<Uint8Array>,
  out: WriteStream,
  kind: RuntimeKind,
  version: string,
  totalBytes: number | undefined,
  hash?: Hash,
): AsyncGenerator<InstallProgress> {
  let received = 0;
  try {
    for await (const chunk of body) {
      received += chunk.length;
      hash?.update(chunk);
      await writeChunk(out, chunk);
      yield { kind, phase: 'download', version, receivedBytes: received, totalBytes };
    }
    await finishWrite(out);
  } catch (e) {
    out.destroy();
    throw e;
  }
}

/**
 * Download a URL to `destFile`, yielding byte progress. Used for installers
 * that consume the file directly (e.g. the Windows Python .exe) rather than
 * extracting an archive. The caller owns `destFile` (creation + cleanup).
 */
export async function* downloadFile(opts: {
  url: string;
  destFile: string;
  kind: RuntimeKind;
  version: string;
  digest?: DownloadDigest;
}): AsyncGenerator<InstallProgress> {
  const { url, destFile, kind, version } = opts;
  assertRuntimeVersion(version);
  const res = await fetch(url);
  if (!res.ok || !res.body) throw new Error(`download failed (${res.status}) for ${url}`);
  const totalBytes = Number(res.headers.get('content-length')) || undefined;
  await mkdir(dirname(destFile), { recursive: true });

  const out = createWriteStream(destFile);
  const hash = opts.digest ? createHash(opts.digest.algorithm) : undefined;
  yield* streamToFile(res.body as unknown as AsyncIterable<Uint8Array>, out, kind, version, totalBytes, hash);
  if (hash) {
    const actual = hash.digest('hex');
    if (actual.toLowerCase() !== opts.digest!.expected.toLowerCase()) {
      throw new Error(`${opts.digest!.algorithm} mismatch for ${url}`);
    }
  }
}

/**
 * Download an archive and extract it into `destDir`, yielding progress
 * frames. Zip is extracted via the design-system util (Windows builds);
 * tarballs via the system `tar` (unix). Does NOT emit the final `done`
 * frame — the caller appends it after re-detecting the runtime, so it can
 * attach the resolved `Runtime`.
 */
export async function* downloadAndExtract(opts: {
  url: string;
  ext: 'zip' | 'tar.gz' | 'tar.xz';
  destDir: string;
  kind: RuntimeKind;
  version: string;
  /** When true, wipe destDir before extracting (default true). */
  clean?: boolean;
  digest?: DownloadDigest;
  /** Validate the staged payload before it is allowed to replace destDir. */
  validateExtracted?: (stagedDir: string) => boolean;
}): AsyncGenerator<InstallProgress> {
  const { url, ext, destDir, kind, version } = opts;
  assertRuntimeVersion(version);
  const tmpFile = join(tmpdir(), `mcp-${kind}-${version}-${process.pid}.${ext}`);
  const clean = opts.clean ?? true;
  const extractDir = clean ? `${destDir}.partial-${process.pid}-${Date.now()}` : destDir;

  const res = await fetch(url);
  if (!res.ok || !res.body) throw new Error(`download failed (${res.status}) for ${url}`);
  const totalBytes = Number(res.headers.get('content-length')) || undefined;
  await mkdir(dirname(destDir), { recursive: true });

  // One try/finally over the whole download+extract so the temp archive is
  // ALWAYS removed — including when the download itself errors mid-transfer.
  try {
    const out = createWriteStream(tmpFile);
    const hash = opts.digest ? createHash(opts.digest.algorithm) : undefined;
    yield* streamToFile(res.body as unknown as AsyncIterable<Uint8Array>, out, kind, version, totalBytes, hash);
    if (hash) {
      const actual = hash.digest('hex');
      if (actual.toLowerCase() !== opts.digest!.expected.toLowerCase()) {
        throw new Error(`${opts.digest!.algorithm} mismatch for ${url}`);
      }
    }

    yield { kind, phase: 'extract', version };
    await mkdir(extractDir, { recursive: true });
    if (ext === 'zip') {
      extractZipToDir(tmpFile, extractDir, { clean });
    } else {
      const flag = ext === 'tar.xz' ? '-xJf' : '-xzf';
      await execFileAsync('tar', [flag, tmpFile, '-C', extractDir], { maxBuffer: 1 << 24 });
    }
    if (opts.validateExtracted && !opts.validateExtracted(extractDir)) {
      throw new Error(`extracted payload failed validation for ${kind} ${version}`);
    }
    if (clean) {
      await rm(destDir, { recursive: true, force: true });
      await rename(extractDir, destDir);
    }
  } finally {
    await rm(tmpFile, { force: true });
    if (clean) await rm(extractDir, { recursive: true, force: true });
  }
}
