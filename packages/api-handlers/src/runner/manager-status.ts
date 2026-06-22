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
import { delimiter } from 'node:path';
import { promisify } from 'node:util';
import type { RunnerManager } from '@mcp/api-bus';

const pexec = promisify(execFile);

const KNOWN: ReadonlySet<string> = new Set([
  'npm', 'yarn', 'pnpm', 'bun', 'composer', 'pip', 'poetry',
]);

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
  pathPrepend: string[],
): Promise<ManagerStatus> {
  if (!KNOWN.has(manager)) return { found: false };
  const PATH = [...pathPrepend, process.env.PATH ?? ''].filter(Boolean).join(delimiter);
  try {
    const { stdout } = await pexec(manager, ['--version'], {
      timeout: 4000,
      encoding: 'utf8',
      shell: true,
      windowsHide: true,
      env: { ...process.env, PATH },
    });
    const m = /(\d+\.\d+(?:\.\d+)?)/.exec(stdout.trim());
    return { found: true, version: m ? m[1] : undefined };
  } catch {
    return { found: false };
  }
}
