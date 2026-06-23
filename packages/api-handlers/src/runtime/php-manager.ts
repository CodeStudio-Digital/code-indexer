/**
 * PHP runtime manager — platform-dispatching front for detection, install,
 * uninstall and extension management. Windows uses the portable zip; macOS/
 * Linux use Homebrew. Extension management is restricted to MANAGED installs
 * (we own their php.ini); see php-extensions.ts / php-pecl.ts.
 */

import { rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { ApiError } from '@mcp/api-bus';
import type { InstallProgress, PhpExtension, Runtime, RuntimeRelease } from '@mcp/api-bus';
import { detectPhpRuntimes } from './detect-php.js';
import { managedRuntimeRoot } from './runtime-shared.js';
import { minorOf } from './detect-shared.js';
import * as winZip from './installers/php-win-zip.js';
import { installViaBrew } from './installers/brew-installer.js';
import { listExtensions as listExt, setExtension as setExt } from './php-extensions.js';
import { installPeclExtension as installPecl } from './php-pecl.js';

const isWin = process.platform === 'win32';
/** Homebrew PHP formula lines we offer on macOS/Linux. */
const BREW_MINORS = ['8.4', '8.3', '8.2', '8.1'];

export function detect(managedDir: string): Runtime[] {
  return detectPhpRuntimes(managedDir);
}

export async function listReleases(): Promise<RuntimeRelease[]> {
  if (isWin) return winZip.listReleases();
  return BREW_MINORS.map((m) => ({ version: m, label: `PHP ${m} (Homebrew)` }));
}

export function install(version: string, managedDir: string): AsyncGenerator<InstallProgress> {
  if (isWin) return winZip.install(version, managedDir);
  const minor = minorOf(version) || version;
  return installViaBrew({
    formula: `php@${minor}`,
    kind: 'php',
    version,
    detect: () => detectPhpRuntimes(managedDir),
  });
}

/** Remove a managed (Windows) install. Homebrew installs aren't ours to delete. */
export async function uninstall(version: string, managedDir: string): Promise<void> {
  await rm(join(managedRuntimeRoot(managedDir, 'php'), version), { recursive: true, force: true });
}

/** Resolve a version string to its install dir (managed) + php bin dir. */
function resolve(version: string, managedDir: string): { installDir: string | null; phpBinDir: string } {
  const managed = join(managedRuntimeRoot(managedDir, 'php'), version);
  if (existsSync(managed)) return { installDir: managed, phpBinDir: managed };
  const match = detectPhpRuntimes(managedDir).find((r) => r.version === version);
  if (!match) throw new ApiError('not_found', 404, `PHP ${version} not found`);
  return { installDir: match.isManaged ? match.binDir : null, phpBinDir: match.binDir };
}

export function listExtensions(version: string, managedDir: string): PhpExtension[] {
  const { installDir } = resolve(version, managedDir);
  if (!installDir) {
    throw new ApiError('unsupported', 400, 'extension management is only available for managed PHP installs');
  }
  return listExt(installDir);
}

export function setExtension(version: string, name: string, enabled: boolean, managedDir: string): void {
  const { installDir } = resolve(version, managedDir);
  if (!installDir) {
    throw new ApiError('unsupported', 400, 'extension management is only available for managed PHP installs');
  }
  setExt(installDir, name, enabled);
}

export function installPeclExtension(
  version: string,
  name: string,
  managedDir: string,
): AsyncGenerator<InstallProgress> {
  const { installDir, phpBinDir } = resolve(version, managedDir);
  return installPecl({ version, name, installDir, phpBinDir });
}

/** Bin dir to prepend to PATH for a chosen PHP id, or null for system default. */
export function resolveBinDir(id: string | null | undefined, managedDir: string): string | null {
  if (!id || id === 'system') return null;
  return detectPhpRuntimes(managedDir).find((r) => r.id === id)?.binDir ?? null;
}
