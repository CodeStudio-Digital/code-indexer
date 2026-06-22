/**
 * Homebrew install strategy (macOS/Linux) for php/python. Shells out to
 * `brew install <formula>` and streams its output as log frames; on success
 * re-detects and emits the resolved runtime. A brew install is system-wide,
 * so the result is detected as a non-managed Homebrew runtime.
 *
 * Precondition: Homebrew present. Absent → a clear error so the UI can tell
 * the user to install Homebrew or pick an existing runtime.
 */

import { existsSync } from 'node:fs';
import type { InstallProgress, Runtime, RuntimeKind } from '@mcp/api-bus';
import { findOnPath, minorOf } from '../detect-shared.js';
import { spawnLogStream } from './shell-stream.js';

/** Resolve a usable `brew` binary path, or null when Homebrew isn't installed. */
export function brewPath(): string | null {
  const known = ['/opt/homebrew/bin/brew', '/usr/local/bin/brew', '/home/linuxbrew/.linuxbrew/bin/brew'];
  for (const p of known) if (existsSync(p)) return p;
  return findOnPath('brew');
}

export async function* installViaBrew(opts: {
  formula: string;
  kind: RuntimeKind;
  version: string;
  detect: () => Runtime[];
}): AsyncGenerator<InstallProgress> {
  const { formula, kind, version, detect } = opts;
  const brew = brewPath();
  if (!brew) {
    throw new Error('Homebrew not found — install it from https://brew.sh or pick an installed runtime');
  }

  yield { kind, phase: 'install', version, line: `brew install ${formula}` };
  for await (const line of spawnLogStream(brew, ['install', formula])) {
    yield { kind, phase: 'log', version, line };
  }

  // brew reports the actual patch; match the chosen minor against detection.
  const want = minorOf(version);
  const runtime =
    detect().find((r) => minorOf(r.version) === want && r.source === 'homebrew') ??
    detect().find((r) => minorOf(r.version) === want);
  yield { kind, phase: 'done', version, runtime };
}
