/**
 * Small, dependency-free helpers shared by the PHP/Python detectors.
 * Same contract as detect-node.ts: best-effort, MUST NOT throw — a probe
 * failure yields '' / null rather than propagating. (detect-node keeps its
 * own private copies to avoid churning a known-good file.)
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { delimiter, join } from 'node:path';

export const isWin = process.platform === 'win32';

/** First match for `exe` across PATH dirs, or null. */
export function findOnPath(exe: string): string | null {
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (!dir) continue;
    const full = join(dir, exe);
    if (existsSync(full)) return full;
  }
  return null;
}

/** Parent dir of a file path (handles both separators). */
export function dirOf(file: string): string {
  const idx = Math.max(file.lastIndexOf('/'), file.lastIndexOf('\\'));
  return idx >= 0 ? file.slice(0, idx) : file;
}

/** "8.3.7" / "8.3" out of arbitrary text; '' if none. */
export function normalizeSemver(raw: string): string {
  const m = /(\d+\.\d+(?:\.\d+)?)/.exec(raw);
  return m ? m[1] : '';
}

/** "8.3" (major.minor) out of a full version; '' if none. */
export function minorOf(version: string): string {
  const m = /(\d+)\.(\d+)/.exec(version);
  return m ? `${m[1]}.${m[2]}` : '';
}

/** Run `exe args` and return trimmed stdout; '' on any failure. */
export function probe(exe: string, args: string[]): string {
  try {
    return execFileSync(exe, args, { timeout: 2500, encoding: 'utf8' }).trim();
  } catch {
    return '';
  }
}

/** Run a probe and return both stdout and stderr (Java reports version on stderr). */
export function probeOutput(exe: string, args: string[]): string {
  try {
    const got = spawnSync(exe, args, { timeout: 2500, encoding: 'utf8', windowsHide: true });
    return `${got.stdout ?? ''}\n${got.stderr ?? ''}`.trim();
  } catch {
    return '';
  }
}

/** Directory children that are directories, matching an optional predicate. */
export function listDirs(parent: string, match?: (name: string) => boolean): string[] {
  if (!parent || !existsSync(parent)) return [];
  try {
    return readdirSync(parent).filter((name) => {
      if (match && !match(name)) return false;
      try {
        return statSync(join(parent, name)).isDirectory();
      } catch {
        return false;
      }
    });
  } catch {
    return [];
  }
}

export function isExecutable(path: string): boolean {
  return !!path && existsSync(path);
}
