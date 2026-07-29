import { lstat, readdir, realpath } from 'node:fs/promises';
import { basename, isAbsolute, join, resolve } from 'node:path';
import {
  currentRuntimeTarget,
  parseRuntimePackageAnchor,
  verifyRuntimePackage,
  type VerifiedRuntimePackage,
} from '../../packages/agent-runtime-host/src/index.js';
import { readInstalledRuntimeAnchor } from './asar-anchor.js';

const EXPECTED_PACKAGE_FILES = new Set([
  'agent-runner',
  'agent-runner.exe',
  'agent-host-bridge.node',
  'agentd-supervisor',
  'agentd-supervisor.exe',
  'manifest.json',
  'manifest.sha256',
]);

export interface InstalledRuntimeLayout {
  readonly appDirectory: string;
  readonly resourcesDirectory: string;
  readonly packageDirectory: string;
  readonly archivePath: string;
  readonly verified: VerifiedRuntimePackage;
}

export async function inspectInstalledRuntime(
  appDirectory: string,
): Promise<InstalledRuntimeLayout> {
  if (!isAbsolute(appDirectory)) {
    throw new TypeError('installed app directory must be absolute');
  }
  const canonicalApp = await realpath(appDirectory);
  if (canonicalApp !== resolve(appDirectory)) {
    throw new TypeError('installed app directory cannot be an alias');
  }
  const appStat = await lstat(canonicalApp);
  if (appStat.isSymbolicLink() || !appStat.isDirectory()) {
    throw new TypeError('installed app root is unsafe');
  }
  const resourcesDirectory = process.platform === 'darwin'
    ? join(canonicalApp, 'Contents', 'Resources')
    : join(canonicalApp, 'resources');
  const archivePath = join(resourcesDirectory, 'app.asar');
  const anchorBytes = await readInstalledRuntimeAnchor(archivePath);
  const anchor = parseRuntimePackageAnchor(anchorBytes);
  const expectedTarget = currentRuntimeTarget();
  if (anchor.targetTriple !== expectedTarget) {
    throw new TypeError('installed package target does not match this host');
  }
  const packageDirectory = join(
    resourcesDirectory,
    'native-agent-runtime',
    expectedTarget,
  );
  const verified = await verifyRuntimePackage(packageDirectory, anchor);
  await assertExactInventory(packageDirectory, verified);
  return Object.freeze({
    appDirectory: canonicalApp,
    resourcesDirectory,
    packageDirectory,
    archivePath,
    verified,
  });
}

async function assertExactInventory(
  packageDirectory: string,
  verified: VerifiedRuntimePackage,
): Promise<void> {
  const expected = new Set([
    ...verified.manifest.binaries.map((binary) => binary.file),
    'manifest.json',
    'manifest.sha256',
  ]);
  const entries = await readdir(packageDirectory, { withFileTypes: true });
  for (const entry of entries) {
    if (
      !entry.isFile()
      || !EXPECTED_PACKAGE_FILES.has(entry.name)
      || !expected.delete(entry.name)
      || basename(entry.name) !== entry.name
    ) throw new TypeError(`unexpected installed runtime entry: ${entry.name}`);
  }
  if (expected.size !== 0) {
    throw new TypeError('installed runtime package is incomplete');
  }
}
