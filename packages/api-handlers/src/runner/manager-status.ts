/**
 * Best-effort "is this package manager available?" probe for a project's
 * effective PATH (the chosen runtime bin dirs prepended). The dependency
 * assistant in the project settings uses it to WARN before an install would
 * fail with "command not found".
 *
 * Async (the Electron main loop must not block on a spawn) + allowlisted (only
 * the known managers run, so `shell: true` carries no injection risk).
 */

import { execFile } from 'node:child_process';
import { delimiter, join } from 'node:path';
import { existsSync } from 'node:fs';
import { promisify } from 'node:util';
import type { RunnerManager } from '@mcp/api-bus';
import { wslBash } from '../runtime/wsl-runtime.js';
import { posixExportPrefix } from '../terminal/pty-manager.js';
import type { RuntimeEnv } from '../runtime/runtime-resolve.js';

const pexec = promisify(execFile);

const KNOWN: ReadonlySet<string> = new Set([
  'npm', 'yarn', 'pnpm', 'bun', 'composer', 'pip', 'poetry', 'maven', 'gradle', 'dotnet',
]);
const BIN: Readonly<Record<string, string>> = { maven: 'mvn', gradle: 'gradle', dotnet: 'dotnet' };

function hasWrapper(root: string, manager: RunnerManager, family: 'windows' | 'posix'): boolean {
  if (manager === 'maven') return existsSync(join(root, family === 'windows' ? 'mvnw.cmd' : 'mvnw'));
  if (manager === 'gradle') return existsSync(join(root, family === 'windows' ? 'gradlew.bat' : 'gradlew'));
  return false;
}

export interface ManagerStatus {
  found: boolean;
  version?: string;
}

/**
 * Run `<manager> --version` with the project's runtime bin dirs prepended to
 * PATH. Resolved via the shell so Windows PATHEXT (.cmd/.exe/.bat shims) works.
 * Returns `{ found: false }` on any failure (not present / errored).
 */
export async function probeManagerStatus(
  manager: RunnerManager,
  env: RuntimeEnv,
  root: string,
  family: 'windows' | 'posix' = process.platform === 'win32' ? 'windows' : 'posix',
): Promise<ManagerStatus> {
  if (!KNOWN.has(manager)) return { found: false };
  if (hasWrapper(root, manager, family)) return { found: true };
  const PATH = [...env.pathPrepend, process.env.PATH ?? ''].filter(Boolean).join(delimiter);
  const bin = BIN[manager] ?? manager;
  try {
    const { stdout, stderr } = await pexec(bin, ['--version'], {
      timeout: 4000,
      encoding: 'utf8',
      shell: true,
      windowsHide: true,
      env: { ...process.env, ...env.extraEnv, PATH },
    });
    const m = /(\d+\.\d+(?:\.\d+)?)/.exec(`${stdout}\n${stderr}`.trim());
    return { found: true, version: m ? m[1] : undefined };
  } catch {
    return { found: false };
  }
}

/**
 * Same probe, but INSIDE a WSL distro — `command -v <manager> && <manager>
 * --version` under a login shell with the distro-managed runtime bin dirs
 * prepended. `manager` is allowlisted (KNOWN), so interpolating it into the
 * bash string carries no injection risk.
 */
export async function probeWslManagerStatus(
  manager: RunnerManager,
  distro: string,
  env: RuntimeEnv,
  root: string,
): Promise<ManagerStatus> {
  if (!KNOWN.has(manager)) return { found: false };
  if (hasWrapper(root, manager, 'posix')) return { found: true };
  const prefix = posixExportPrefix(env.posixPathPrepend, env.posixExtraEnv);
  const bin = BIN[manager] ?? manager;
  const out = await wslBash(distro, `${prefix}command -v ${bin} >/dev/null 2>&1 && ${bin} --version 2>&1 || true`);
  if (!out) return { found: false };
  const m = /(\d+\.\d+(?:\.\d+)?)/.exec(out);
  return { found: true, version: m ? m[1] : undefined };
}
