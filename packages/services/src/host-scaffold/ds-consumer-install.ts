/**
 * Install/uninstall a published design-system package into a host project.
 * Pairs the `.npmrc` scope mapping with the actual `npm install` so the two
 * never drift: scoped packages resolve via the npmrc line (future installs
 * keep working), unscoped ones fall back to an explicit `--registry` flag.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runHostCommand, type RunHostCommandResult } from './run-host-command.js';
import { INSTALL_TIMEOUT_MS, NON_INTERACTIVE_ENV } from './templates/types.js';
import { removeNpmrcScopedRegistry, upsertNpmrcScopedRegistry } from './npmrc.js';

export interface InstallDsPackageInput {
  /** Host project root (absolute). */
  dir: string;
  packageName: string;
  semver: string;
  /** Loopback registry URL (host npm reaches Verdaccio here). */
  registryUrl: string;
  signal?: AbortSignal;
  onLog?: (stream: 'stdout' | 'stderr', chunk: string) => void;
  /** Test seam. */
  runCmd?: typeof runHostCommand;
}

function readNpmrc(dir: string): string | null {
  try {
    return readFileSync(join(dir, '.npmrc'), 'utf-8');
  } catch {
    return null;
  }
}

export async function installDsPackage(input: InstallDsPackageInput): Promise<RunHostCommandResult> {
  const { dir, packageName, semver, registryUrl } = input;
  const runCmd = input.runCmd ?? runHostCommand;

  const npmrc = upsertNpmrcScopedRegistry(readNpmrc(dir), packageName, registryUrl);
  if (npmrc.changed) writeFileSync(join(dir, '.npmrc'), npmrc.content, 'utf-8');

  const args = [
    'install',
    `${packageName}@${semver}`,
    '--save-exact',
    '--no-audit',
    '--no-fund',
    '--loglevel=error',
  ];
  if (!npmrc.scoped) args.push('--registry', registryUrl);

  return runCmd({
    program: 'npm',
    args,
    cwd: dir,
    env: NON_INTERACTIVE_ENV,
    timeoutMs: INSTALL_TIMEOUT_MS,
    signal: input.signal,
    onLog: input.onLog,
  });
}

export interface UninstallDsPackageInput {
  dir: string;
  packageName: string;
  signal?: AbortSignal;
  runCmd?: typeof runHostCommand;
}

/** Best-effort removal: npm uninstall + drop the npmrc scope line. */
export async function uninstallDsPackage(input: UninstallDsPackageInput): Promise<RunHostCommandResult> {
  const runCmd = input.runCmd ?? runHostCommand;
  const result = await runCmd({
    program: 'npm',
    args: ['uninstall', input.packageName, '--no-audit', '--no-fund', '--loglevel=error'],
    cwd: input.dir,
    env: NON_INTERACTIVE_ENV,
    timeoutMs: INSTALL_TIMEOUT_MS,
    signal: input.signal,
  });
  const npmrc = removeNpmrcScopedRegistry(readNpmrc(input.dir), input.packageName);
  if (npmrc.changed) writeFileSync(join(input.dir, '.npmrc'), npmrc.content, 'utf-8');
  return result;
}
