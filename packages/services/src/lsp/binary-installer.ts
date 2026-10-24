/**
 * Installer for 'binary' LSP servers — download a pinned GitHub release
 * asset, verify sha256 WHEN the registry carries one (never guessed),
 * extract, chmod, and validate the executable. Progress uses the same
 * frame shape as the npm installer (LspInstallProgress), so both flows
 * stream through lsp.installServerStream unchanged.
 *
 * Extraction matrix (no new deps):
 *   zip     → PowerShell Expand-Archive on win32, `unzip -o` elsewhere
 *   gz      → single-file gunzip (node:zlib) written to binRelPath
 *   tar.gz  → system `tar -xzf` (present on win10+/macOS/linux)
 *   none    → raw copy to binRelPath
 */
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, copyFileSync, createWriteStream, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, type WriteStream } from 'node:fs';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { gunzipSync } from 'node:zlib';
import type { LspInstallProgress } from './install-progress.js';
import { binaryAssetFor, type LspBinaryAsset, type LspServerDef } from './server-registry.js';

const execFileAsync = promisify(execFile);

function mb(n: number): string {
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/** write() resolved via callback — handles backpressure AND write errors. */
function writeChunk(out: WriteStream, chunk: Uint8Array): Promise<void> {
  return new Promise((resolve, reject) => {
    out.write(chunk, (err) => (err ? reject(err) : resolve()));
  });
}

/** Stream `url` to `destFile`, hashing as it goes. Returns the sha256 hex. */
async function* downloadTo(
  url: string,
  destFile: string,
  signal?: AbortSignal,
): AsyncGenerator<LspInstallProgress, string> {
  const res = await fetch(url, { signal });
  if (!res.ok || !res.body) throw new Error(`download failed (${res.status}) for ${url}`);
  const total = Number(res.headers.get('content-length')) || undefined;
  const hash = createHash('sha256');
  const out = createWriteStream(destFile);
  let received = 0;
  let lastLogged = 0;
  try {
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      hash.update(chunk);
      received += chunk.length;
      await writeChunk(out, chunk);
      if (received - lastLogged >= 4 * 1024 * 1024) {
        lastLogged = received;
        yield { phase: 'log', line: `downloaded ${mb(received)}${total ? ` / ${mb(total)}` : ''}` };
      }
    }
    await new Promise<void>((resolve, reject) => { out.once('error', reject); out.end(() => resolve()); });
  } catch (err) {
    out.destroy();
    throw err;
  }
  yield { phase: 'log', line: `downloaded ${mb(received)}` };
  return hash.digest('hex');
}

async function extract(asset: LspBinaryAsset, tmpFile: string, installDir: string, binRelPath: string): Promise<void> {
  if (asset.archive === 'zip') {
    if (process.platform === 'win32') {
      // -LiteralPath avoids wildcard surprises; ' doubled for PS quoting.
      const q = (s: string): string => `'${s.replace(/'/g, "''")}'`;
      await execFileAsync('powershell.exe', [
        '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command',
        `Expand-Archive -LiteralPath ${q(tmpFile)} -DestinationPath ${q(installDir)} -Force`,
      ], { maxBuffer: 1 << 22 });
    } else {
      await execFileAsync('unzip', ['-o', tmpFile, '-d', installDir], { maxBuffer: 1 << 22 });
    }
    return;
  }
  if (asset.archive === 'tar.gz') {
    await execFileAsync('tar', ['-xzf', tmpFile, '-C', installDir], { maxBuffer: 1 << 22 });
    return;
  }
  // 'gz' (single-file) and 'none' land directly at binRelPath.
  const outFile = join(installDir, binRelPath);
  mkdirSync(dirname(outFile), { recursive: true });
  if (asset.archive === 'gz') writeFileSync(outFile, gunzipSync(readFileSync(tmpFile)));
  else copyFileSync(tmpFile, outFile);
}

/**
 * Install a binary-kind server def into `installDir`. Mirrors the npm
 * installer contract: never throws — failures surface as an 'error' frame
 * and the generator returns. The caller emits the 'start' frame.
 */
export async function* installBinaryServer(
  def: LspServerDef,
  installDir: string,
  opts: { signal?: AbortSignal } = {},
): AsyncGenerator<LspInstallProgress> {
  if (def.install.kind !== 'binary') {
    yield { phase: 'error', message: `${def.id} is not a binary-kind server` };
    return;
  }
  const resolved = binaryAssetFor(def);
  if (!resolved) {
    yield { phase: 'error', message: `no binary asset of ${def.id} for ${process.platform}-${process.arch}` };
    return;
  }
  const { asset, binRelPath } = resolved;
  const tmpFile = join(installDir, `_download.${asset.archive === 'none' ? 'bin' : asset.archive}`);

  try {
    mkdirSync(installDir, { recursive: true });
    const binAbs = join(installDir, binRelPath);
    if (!existsSync(binAbs)) {
      yield { phase: 'log', line: `downloading ${asset.url}` };
      const digest = yield* downloadTo(asset.url, tmpFile, opts.signal);

      if (asset.sha256) {
        if (digest !== asset.sha256.toLowerCase()) {
          yield { phase: 'error', message: `sha256 mismatch for ${asset.url}: expected ${asset.sha256}, got ${digest}` };
          return;
        }
        yield { phase: 'log', line: 'sha256 verified' };
      }

      yield { phase: 'log', line: `extracting (${asset.archive})` };
      await extract(asset, tmpFile, installDir, binRelPath);
    } else {
      yield { phase: 'log', line: `using existing ${binRelPath}` };
    }

    if (!existsSync(binAbs)) {
      yield { phase: 'error', message: `extraction succeeded but the binary was not found at ${binRelPath}` };
      return;
    }
    if (process.platform !== 'win32') chmodSync(binAbs, 0o755);

    for (const [index, companion] of (def.install.companions ?? []).entries()) {
      const companionAbs = join(installDir, companion.relPath);
      if (existsSync(companionAbs)) continue;
      const companionTmp = join(installDir, `_download.companion-${index}`);
      try {
        yield { phase: 'log', line: `downloading ${companion.url}` };
        const digest = yield* downloadTo(companion.url, companionTmp, opts.signal);
        if (digest !== companion.sha256.toLowerCase()) {
          yield { phase: 'error', message: `sha256 mismatch for ${companion.url}: expected ${companion.sha256}, got ${digest}` };
          return;
        }
        yield { phase: 'log', line: `sha256 verified (${companion.relPath})` };
        mkdirSync(dirname(companionAbs), { recursive: true });
        copyFileSync(companionTmp, companionAbs);
      } finally {
        rmSync(companionTmp, { force: true });
      }
    }
    yield { phase: 'done', installDir };
  } catch (err) {
    yield { phase: 'error', message: err instanceof Error ? err.message : String(err) };
  } finally {
    rmSync(tmpFile, { force: true });
  }
}
