/**
 * Node runtime manager — resolve a project's chosen Node to a bin dir,
 * list official releases, and download/extract/remove managed installs.
 *
 * Managed builds land under `<managedDir>/node/v<version>/` (the official
 * archive's top folder kept intact). Downloads stream with progress so
 * the UI can show a bar. Extraction reuses the design-system zip util on
 * Windows and the system `tar` on unix (no new dependency).
 */

import { execFile } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { extractZipToDir } from '@mcp/design-system/extract-zip.js';
import type { DownloadProgress, NodeRelease, NodeRuntime } from '@mcp/api-bus';
import type { CodeIndexDB } from '@mcp/store/db.js';
import { detectNodeRuntimes, managedNodeRoot } from './detect-node.js';

const execFileAsync = promisify(execFile);
const isWin = process.platform === 'win32';

/**
 * Resolve the bin dir to prepend to PATH for a project's chosen Node.
 * Returns null when the project uses the system default (no injection).
 */
export function resolveProjectNodeBinDir(
  db: CodeIndexDB,
  projectId: number,
  managedDir: string,
): string | null {
  const project = db.getProject(projectId);
  const id = project?.node_version;
  if (!id || id === 'system') return null;
  const match = detectNodeRuntimes(managedDir).find((r) => r.id === id);
  return match ? match.binDir : null;
}

/** Fetch official releases (LTS + recent current) from nodejs.org. */
export async function listAvailable(): Promise<NodeRelease[]> {
  const res = await fetch('https://nodejs.org/dist/index.json');
  if (!res.ok) throw new Error(`nodejs.org returned ${res.status}`);
  const raw = (await res.json()) as Array<{
    version: string;
    date: string;
    lts: string | false;
    security?: boolean;
  }>;
  const all = raw.map((r) => ({
    version: r.version.replace(/^v/, ''),
    date: r.date,
    lts: r.lts ?? false,
    security: !!r.security,
  }));
  // All LTS lines + the newest handful of non-LTS current releases.
  const lts = all.filter((r) => r.lts);
  const current = all.filter((r) => !r.lts).slice(0, 8);
  return [...lts, ...current];
}

/** node dist arch token for this machine. */
function distArch(): string {
  switch (process.arch) {
    case 'arm64':
      return 'arm64';
    case 'ia32':
      return 'x86';
    default:
      return 'x64';
  }
}

function distPlatform(): string {
  if (isWin) return 'win';
  if (process.platform === 'darwin') return 'darwin';
  return 'linux';
}

/** Build the download URL + the archive's inner folder name. */
function distInfo(version: string): { url: string; folder: string; ext: string } {
  const folder = `node-v${version}-${distPlatform()}-${distArch()}`;
  const ext = isWin ? 'zip' : 'tar.gz';
  return { url: `https://nodejs.org/dist/v${version}/${folder}.${ext}`, folder, ext };
}

/**
 * Download + extract a Node build into the managed dir, yielding progress.
 * The generator is consumed by the `runtime.download` stream handler.
 */
export async function* download(
  version: string,
  managedDir: string,
): AsyncGenerator<DownloadProgress> {
  const { url, ext } = distInfo(version);
  const destBase = join(managedNodeRoot(managedDir), `v${version}`);
  const tmpFile = join(tmpdir(), `mcp-node-${version}-${Date.now()}.${ext}`);

  // ── download ──
  const res = await fetch(url);
  if (!res.ok || !res.body) throw new Error(`download failed (${res.status}) for ${url}`);
  const totalBytes = Number(res.headers.get('content-length')) || undefined;
  let received = 0;
  await mkdir(destBase, { recursive: true });

  const out = createWriteStream(tmpFile);
  try {
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      received += chunk.length;
      if (!out.write(chunk)) await new Promise<void>((r) => out.once('drain', () => r()));
      yield { phase: 'download', version, receivedBytes: received, totalBytes };
    }
  } finally {
    out.end();
    await new Promise<void>((r) => out.once('close', () => r()));
  }

  // ── extract ──
  yield { phase: 'extract', version };
  if (ext === 'zip') {
    extractZipToDir(tmpFile, destBase, { clean: true });
  } else {
    await execFileAsync('tar', ['-xzf', tmpFile, '-C', destBase], { maxBuffer: 1 << 24 });
  }
  await rm(tmpFile, { force: true });

  // ── done ──
  const runtime = detectNodeRuntimes(managedDir).find((r) => r.id === `managed:${version}`);
  if (!runtime) throw new Error(`extracted but could not locate node under ${destBase}`);
  yield { phase: 'done', version, runtime };
}

/** Remove a managed install. */
export async function remove(version: string, managedDir: string): Promise<void> {
  const destBase = join(managedNodeRoot(managedDir), `v${version}`);
  await rm(destBase, { recursive: true, force: true });
}

/** Convenience for handlers. */
export function listInstalled(managedDir: string): NodeRuntime[] {
  return detectNodeRuntimes(managedDir);
}
