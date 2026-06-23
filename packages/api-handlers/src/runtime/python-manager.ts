/**
 * Python runtime manager — platform-dispatching front for detection, install
 * and uninstall. Windows uses the official silent installer (full Python with
 * pip + venv); macOS/Linux prefer pyenv, falling back to Homebrew.
 */

import { rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { InstallProgress, Runtime, RuntimeRelease } from '@mcp/api-bus';
import { detectPythonRuntimes } from './detect-python.js';
import { managedRuntimeRoot } from './runtime-shared.js';
import { isWin, minorOf } from './detect-shared.js';
import * as winInstaller from './installers/python-win-installer.js';
import * as pyenv from './installers/pyenv-installer.js';
import { installViaBrew } from './installers/brew-installer.js';

/** Homebrew Python formula lines we offer when pyenv is absent. */
const BREW_MINORS = ['3.13', '3.12', '3.11', '3.10', '3.9'];

export function detect(managedDir: string): Runtime[] {
  return detectPythonRuntimes(managedDir);
}

export async function listReleases(): Promise<RuntimeRelease[]> {
  if (isWin) return winInstaller.listReleases();
  const fromPyenv = await pyenv.listReleases();
  if (fromPyenv.length) return fromPyenv.map((version) => ({ version }));
  return BREW_MINORS.map((m) => ({ version: m, label: `Python ${m} (Homebrew)` }));
}

export function install(version: string, managedDir: string): AsyncGenerator<InstallProgress> {
  if (isWin) return winInstaller.install(version, managedDir);
  if (pyenv.pyenvPath()) {
    return pyenv.install({ version, detect: () => detectPythonRuntimes(managedDir) });
  }
  const minor = minorOf(version) || version;
  return installViaBrew({
    formula: `python@${minor}`,
    kind: 'python',
    version,
    detect: () => detectPythonRuntimes(managedDir),
  });
}

/** Remove a managed (Windows) install. pyenv/brew installs aren't ours to delete. */
export async function uninstall(version: string, managedDir: string): Promise<void> {
  await rm(join(managedRuntimeRoot(managedDir, 'python'), version), { recursive: true, force: true });
}

/**
 * Dirs to prepend to PATH for a chosen Python id (empty for system default).
 * Windows adds the `Scripts` dir so `pip`/console-scripts resolve; unix bin
 * already holds them.
 */
export function resolveBinDirs(id: string | null | undefined, managedDir: string): string[] {
  if (!id || id === 'system') return [];
  const r = detectPythonRuntimes(managedDir).find((x) => x.id === id);
  if (!r) return [];
  const scripts = isWin ? [join(r.binDir, 'Scripts')] : [];
  return [r.binDir, ...scripts.filter((d) => existsSync(d))];
}
