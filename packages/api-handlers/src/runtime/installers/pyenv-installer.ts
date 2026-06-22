/**
 * pyenv install strategy (macOS/Linux) for Python — installs into pyenv's own
 * `~/.pyenv/versions/<ver>` (compiles from source; needs pyenv + build deps).
 * Streams pyenv's output as log frames; on success re-detects the runtime.
 *
 * Precondition: pyenv present. Absent → a clear error so the manager can fall
 * back to Homebrew or the UI can tell the user to install pyenv.
 */

import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { InstallProgress, Runtime } from '@mcp/api-bus';
import { findOnPath } from '../detect-shared.js';
import { spawnLogStream } from './shell-stream.js';

/** Resolve a usable `pyenv` binary path, or null when pyenv isn't installed. */
export function pyenvPath(): string | null {
  const known = join(homedir(), '.pyenv', 'bin', 'pyenv');
  if (existsSync(known)) return known;
  return findOnPath('pyenv');
}

/** `pyenv install --list` → final `3.x.y` versions, newest first. */
export async function listReleases(): Promise<string[]> {
  const pyenv = pyenvPath();
  if (!pyenv) return [];
  const versions: string[] = [];
  try {
    for await (const line of spawnLogStream(pyenv, ['install', '--list'])) {
      const m = /^\s*(3\.\d+\.\d+)\s*$/.exec(line);
      if (m) versions.push(m[1]);
    }
  } catch {
    return [];
  }
  return versions.sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
}

export async function* install(opts: {
  version: string;
  detect: () => Runtime[];
}): AsyncGenerator<InstallProgress> {
  const { version, detect } = opts;
  const pyenv = pyenvPath();
  if (!pyenv) {
    throw new Error('pyenv not found — install pyenv (or Homebrew) or pick an installed Python');
  }

  yield { kind: 'python', phase: 'install', version, line: `pyenv install ${version}` };
  for await (const line of spawnLogStream(pyenv, ['install', '-s', version])) {
    yield { kind: 'python', phase: 'log', version, line };
  }

  const runtime = detect().find((r) => r.source === 'pyenv' && r.version === version);
  yield { kind: 'python', phase: 'done', version, runtime };
}
