/**
 * PHP runtime detection — enumerates PHP installs on the machine so the
 * project picker can offer a real choice. Best-effort, MUST NOT throw
 * (mirrors detect-node.ts).
 *
 * Sources: system PATH, our managed installs (under dataDir/php/<ver>/),
 * Homebrew (prefix/opt/php[@x.y]/bin), Scoop and Chocolatey on Windows.
 */

import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Runtime, RuntimeSource } from '@mcp/api-bus';
import { managedRuntimeRoot } from './runtime-shared.js';
import { dirOf, findOnPath, isExecutable, isWin, listDirs, normalizeSemver, probe } from './detect-shared.js';

const PHP_EXE = isWin ? 'php.exe' : 'php';

export function detectPhpRuntimes(managedDir: string): Runtime[] {
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
    if (isWin) {
      for (const r of scoopRuntimes()) add(r);
      for (const r of chocoRuntimes()) add(r);
    } else {
      for (const r of homebrewRuntimes()) add(r);
    }
  } catch {
    /* defensive — return whatever we gathered */
  }
  return out;
}

/** Build a PHP Runtime from the dir holding php(.exe). */
function phpAt(binDir: string, source: RuntimeSource, isManaged: boolean, knownVersion?: string): Runtime | null {
  const exe = join(binDir, PHP_EXE);
  if (!isExecutable(exe)) return null;
  const version = knownVersion || normalizeSemver(probe(exe, ['-v']));
  const id = source === 'system' ? 'system' : `${source}:${version || binDir}`;
  const label = version ? `PHP ${version} (${source})` : `PHP (${binDir})`;
  return { kind: 'php', id, label, version, binDir, source, isManaged };
}

function systemRuntime(): Runtime | null {
  const exe = findOnPath(PHP_EXE);
  return exe ? phpAt(dirOf(exe), 'system', false) : null;
}

/** managedDir/php/<version>/php(.exe) - version folder name is authoritative. */
function managedRuntimes(managedDir: string): Runtime[] {
  const root = managedRuntimeRoot(managedDir, 'php');
  return listDirs(root)
    .map((name) => phpAt(join(root, name), 'managed', true, normalizeSemver(name) || undefined))
    .filter((r): r is Runtime => r !== null);
}

/** Homebrew: prefix/opt/php and prefix/opt/php@8.3, with php under its bin/. */
function homebrewRuntimes(): Runtime[] {
  const prefixes = ['/opt/homebrew', '/usr/local', '/home/linuxbrew/.linuxbrew'];
  const out: Runtime[] = [];
  for (const prefix of prefixes) {
    const optDir = join(prefix, 'opt');
    for (const name of listDirs(optDir, (n) => n === 'php' || n.startsWith('php@'))) {
      const r = phpAt(join(optDir, name, 'bin'), 'homebrew', false);
      if (r) out.push(r);
    }
  }
  return out;
}

/** Scoop: ~/scoop/apps/php(.x)/current/php.exe under the user profile. */
function scoopRuntimes(): Runtime[] {
  const apps = join(homedir(), 'scoop', 'apps');
  const out: Runtime[] = [];
  for (const name of listDirs(apps, (n) => n === 'php' || n.startsWith('php'))) {
    const r = phpAt(join(apps, name, 'current'), 'scoop', false);
    if (r) out.push(r);
  }
  return out;
}

/** Chocolatey: installs PHP under C:/tools/php* (e.g. C:/tools/php83). */
function chocoRuntimes(): Runtime[] {
  const tools = join(process.env.SystemDrive ?? 'C:', '\\', 'tools');
  const out: Runtime[] = [];
  for (const name of listDirs(tools, (n) => n.startsWith('php'))) {
    const r = phpAt(join(tools, name), 'choco', false);
    if (r) out.push(r);
  }
  return out;
}
