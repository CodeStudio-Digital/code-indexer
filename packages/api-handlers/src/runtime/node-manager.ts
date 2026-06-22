/**
 * Node runtime manager — resolve a project's chosen Node to a bin dir,
 * list official releases, and install/remove managed builds.
 *
 * Managed builds land under `<managedDir>/node/v<version>/` (the official
 * archive's top folder kept intact). Downloads stream with progress via the
 * shared `downloadAndExtract` generator (zip on Windows, tar on unix).
 */

import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { InstallProgress, RuntimeRelease } from '@mcp/api-bus';
import type { CodeIndexDB } from '@mcp/store/db.js';
import { detectNodeRuntimes, managedNodeRoot } from './detect-node.js';
import { downloadAndExtract } from './runtime-shared.js';

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
export async function listAvailable(): Promise<RuntimeRelease[]> {
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

/** Build the download URL + archive extension. */
function distInfo(version: string): { url: string; ext: 'zip' | 'tar.gz' } {
  const folder = `node-v${version}-${distPlatform()}-${distArch()}`;
  const ext = isWin ? 'zip' : 'tar.gz';
  return { url: `https://nodejs.org/dist/v${version}/${folder}.${ext}`, ext };
}

/**
 * Download + extract a Node build into the managed dir, yielding progress.
 * The generator is consumed by the `runtime.install` stream handler.
 */
export async function* download(
  version: string,
  managedDir: string,
): AsyncGenerator<InstallProgress> {
  const { url, ext } = distInfo(version);
  const destBase = join(managedNodeRoot(managedDir), `v${version}`);
  yield* downloadAndExtract({ url, ext, destDir: destBase, kind: 'node', version });
  const runtime = detectNodeRuntimes(managedDir).find((r) => r.id === `managed:${version}`);
  if (!runtime) throw new Error(`extracted but could not locate node under ${destBase}`);
  yield { kind: 'node', phase: 'done', version, runtime };
}

/** Remove a managed install. */
export async function remove(version: string, managedDir: string): Promise<void> {
  const destBase = join(managedNodeRoot(managedDir), `v${version}`);
  await rm(destBase, { recursive: true, force: true });
}
