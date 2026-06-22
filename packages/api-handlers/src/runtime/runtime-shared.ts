/**
 * Shared scaffolding for runtime managers (node/php/python). Holds the
 * managed-install root layout and a generic download+extract generator so
 * each kind's manager doesn't re-implement streaming/IO. Detection-side
 * helpers (PATH probing, version folder scans) stay in detect-*.ts.
 */

import { execFile } from 'node:child_process';
import { createWriteStream, type WriteStream } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { extractZipToDir } from '@mcp/design-system/extract-zip.js';
import type { InstallProgress, RuntimeKind } from '@mcp/api-bus';

const execFileAsync = promisify(execFile);

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
): AsyncGenerator<InstallProgress> {
  let received = 0;
  try {
    for await (const chunk of body) {
      received += chunk.length;
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
}): AsyncGenerator<InstallProgress> {
  const { url, destFile, kind, version } = opts;
  const res = await fetch(url);
  if (!res.ok || !res.body) throw new Error(`download failed (${res.status}) for ${url}`);
  const totalBytes = Number(res.headers.get('content-length')) || undefined;
  await mkdir(dirname(destFile), { recursive: true });

  const out = createWriteStream(destFile);
  yield* streamToFile(res.body as unknown as AsyncIterable<Uint8Array>, out, kind, version, totalBytes);
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
}): AsyncGenerator<InstallProgress> {
  const { url, ext, destDir, kind, version } = opts;
  const tmpFile = join(tmpdir(), `mcp-${kind}-${version}-${process.pid}.${ext}`);

  const res = await fetch(url);
  if (!res.ok || !res.body) throw new Error(`download failed (${res.status}) for ${url}`);
  const totalBytes = Number(res.headers.get('content-length')) || undefined;
  await mkdir(destDir, { recursive: true });

  // One try/finally over the whole download+extract so the temp archive is
  // ALWAYS removed — including when the download itself errors mid-transfer.
  try {
    const out = createWriteStream(tmpFile);
    yield* streamToFile(res.body as unknown as AsyncIterable<Uint8Array>, out, kind, version, totalBytes);

    yield { kind, phase: 'extract', version };
    if (ext === 'zip') {
      extractZipToDir(tmpFile, destDir, { clean: opts.clean ?? true });
    } else {
      const flag = ext === 'tar.xz' ? '-xJf' : '-xzf';
      await execFileAsync('tar', [flag, tmpFile, '-C', destDir], { maxBuffer: 1 << 24 });
    }
  } finally {
    await rm(tmpFile, { force: true });
  }
}
