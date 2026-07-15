/**
 * .NET SDK detection — enumerates dotnet roots on the machine. Best-effort,
 * MUST NOT throw (mirrors detect-php.ts).
 *
 * A ".NET runtime" here is a dotnet ROOT dir (dotnet(.exe) + sdk/ + shared/):
 * the SDK archive layout is FLAT, so for managed installs the version dir IS
 * the bin dir. Version comes from the newest folder under <root>/sdk — we
 * never spawn `dotnet --version` (it honours global.json of the cwd).
 */

import { homedir } from 'node:os';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Runtime, RuntimeSource } from '@mcp/api-bus';
import { managedRuntimeRoot } from './runtime-shared.js';
import { dirOf, findOnPath, isWin, listDirs } from './detect-shared.js';

const DOTNET_EXE = isWin ? 'dotnet.exe' : 'dotnet';

/** Numeric-aware version compare, preview suffixes sort BELOW their release. */
export function compareDotnetVersions(a: string, b: string): number {
  const parse = (v: string): { nums: number[]; pre: string } => {
    const [core, ...pre] = v.split('-');
    return { nums: core.split('.').map((n) => Number(n) || 0), pre: pre.join('-') };
  };
  const pa = parse(a);
  const pb = parse(b);
  for (let i = 0; i < Math.max(pa.nums.length, pb.nums.length); i++) {
    const d = (pa.nums[i] ?? 0) - (pb.nums[i] ?? 0);
    if (d !== 0) return d;
  }
  if (!pa.pre && pb.pre) return 1;
  if (pa.pre && !pb.pre) return -1;
  return pa.pre.localeCompare(pb.pre);
}

/** Newest SDK version installed under a dotnet root ('' when none). */
export function newestSdkVersionOf(root: string): string {
  const versions = listDirs(join(root, 'sdk'));
  versions.sort((a, b) => compareDotnetVersions(b, a));
  return versions[0] ?? '';
}

export function detectDotnetRuntimes(managedDir: string): Runtime[] {
  const out: Runtime[] = [];
  const seen = new Set<string>();
  const add = (r: Runtime | null): void => {
    if (!r || seen.has(r.binDir.toLowerCase())) return;
    seen.add(r.binDir.toLowerCase());
    out.push(r);
  };

  try {
    add(systemRuntime());
    for (const r of managedRuntimes(managedDir)) add(r);
    add(dotnetAt(process.env.DOTNET_ROOT ?? '', 'dotnetroot', false));
    for (const root of defaultRoots()) add(dotnetAt(root, 'programfiles', false));
  } catch {
    /* defensive — return whatever we gathered */
  }
  return out;
}

/** Build a .NET Runtime from a dotnet root (dir holding dotnet(.exe)). */
function dotnetAt(root: string, source: RuntimeSource, isManaged: boolean, knownVersion?: string): Runtime | null {
  if (!root || !existsSync(join(root, DOTNET_EXE))) return null;
  // A managed directory name is only a claim. Require the matching SDK
  // payload too, otherwise an interrupted/misplaced extraction would surface
  // as a usable SDK under the wrong version.
  if (knownVersion && !existsSync(join(root, 'sdk', knownVersion))) return null;
  const detectedVersion = newestSdkVersionOf(root);
  if (!detectedVersion) return null;
  const version = knownVersion || detectedVersion;
  const id = source === 'system' ? 'system' : `${source}:${version || root}`;
  const label = version ? `.NET SDK ${version} (${source})` : `.NET (${root})`;
  return { kind: 'dotnet', id, label, version, binDir: root, source, isManaged };
}

function systemRuntime(): Runtime | null {
  const exe = findOnPath(DOTNET_EXE);
  return exe ? dotnetAt(dirOf(exe), 'system', false) : null;
}

/** managedDir/dotnet/<version>/dotnet(.exe) — flat archive, folder name is the SDK version. */
function managedRuntimes(managedDir: string): Runtime[] {
  const root = managedRuntimeRoot(managedDir, 'dotnet');
  return listDirs(root)
    .map((name) => dotnetAt(join(root, name), 'managed', true, name))
    .filter((r): r is Runtime => r !== null);
}

/** Default install roots per platform. */
function defaultRoots(): string[] {
  if (isWin) return [join(process.env.ProgramFiles ?? 'C:\\Program Files', 'dotnet')];
  return ['/usr/share/dotnet', '/usr/local/share/dotnet', join(homedir(), '.dotnet')];
}
