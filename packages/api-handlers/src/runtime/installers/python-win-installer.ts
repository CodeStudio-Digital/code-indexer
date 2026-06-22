/**
 * Windows Python install — official python.org installer run silently into a
 * managed TargetDir. Gives a FULL Python (pip + venv), unlike the embeddable
 * zip. Doesn't touch the system PATH (PrependPath=0) — we prepend the managed
 * dir ourselves at spawn time.
 *
 * Versions come from the python.org FTP index; install verifies the exact
 * .exe exists before running.
 */

import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { InstallProgress, RuntimeRelease } from '@mcp/api-bus';
import { managedRuntimeRoot, downloadFile } from '../runtime-shared.js';
import { detectPythonRuntimes } from '../detect-python.js';
import { spawnLogStream } from './shell-stream.js';

const FTP_BASE = 'https://www.python.org/ftp/python/';

function arch(): 'amd64' | 'arm64' {
  return process.arch === 'arm64' ? 'arm64' : 'amd64';
}

function installerUrl(version: string): string {
  return `${FTP_BASE}${version}/python-${version}-${arch()}.exe`;
}

/** Parse the FTP index for final `3.x.y` releases (newest first, bounded). */
export async function listReleases(): Promise<RuntimeRelease[]> {
  const res = await fetch(FTP_BASE);
  if (!res.ok) throw new Error(`python.org returned ${res.status}`);
  const html = await res.text();
  const versions = new Set<string>();
  for (const m of html.matchAll(/href="(3\.\d+\.\d+)\/"/g)) {
    const [maj, min] = m[1].split('.').map(Number);
    if (maj === 3 && min >= 9) versions.add(m[1]);
  }
  return [...versions]
    .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))
    .slice(0, 30)
    .map((version) => ({ version }));
}

export async function* install(version: string, managedDir: string): AsyncGenerator<InstallProgress> {
  const url = installerUrl(version);
  const head = await fetch(url, { method: 'HEAD' });
  if (!head.ok) throw new Error(`no python.org ${arch()} installer for Python ${version}`);

  const exe = join(tmpdir(), `mcp-python-${version}-${process.pid}.exe`);
  const targetDir = join(managedRuntimeRoot(managedDir, 'python'), version);
  // Download + run under ONE try/finally so a mid-download failure still
  // removes the partial .exe (no orphaned ~30 MB temp files).
  try {
    yield* downloadFile({ url, destFile: exe, kind: 'python', version });

    yield { kind: 'python', phase: 'install', version, line: 'Running silent installer…' };
    // Per-user, no PATH/launcher/shortcuts/assoc — a self-contained tree we own.
    const args = [
      '/quiet',
      'InstallAllUsers=0',
      'PrependPath=0',
      'Include_launcher=0',
      'AssociateFiles=0',
      'Shortcuts=0',
      'Include_test=0',
      `TargetDir=${targetDir}`,
    ];
    // 3010 / 1641 = success-but-reboot-required (a chained VC++ runtime asked
    // for a reboot); Python is fully installed under TargetDir, so accept them.
    for await (const line of spawnLogStream(exe, args, { okExitCodes: [0, 3010, 1641] })) {
      yield { kind: 'python', phase: 'log', version, line };
    }
  } finally {
    await rm(exe, { force: true });
  }

  const runtime = detectPythonRuntimes(managedDir).find((r) => r.id === `managed:${version}`);
  if (!runtime) throw new Error(`installer ran but could not locate python under ${targetDir}`);
  yield { kind: 'python', phase: 'done', version, runtime };
}
