import { spawnSync } from 'node:child_process';
import {
  chmod,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import {
  type RuntimePackageAnchor,
  verifyRuntimePackage,
} from '../../packages/agent-runtime-host/src/index.js';

export async function withReadOnlyPackage(
  sourceDirectory: string,
  anchor: RuntimePackageAnchor,
  scratchDirectory: string,
  run: (packageDirectory: string) => Promise<void>,
): Promise<void> {
  const scratchRoot = resolve(scratchDirectory);
  await mkdir(scratchRoot, { recursive: true });
  const temporaryRoot = await mkdtemp(join(scratchRoot, 'installed-runtime-'));
  if (dirname(temporaryRoot) !== scratchRoot) {
    throw new TypeError('read-only smoke escaped its scratch root');
  }
  const packageDirectory = join(temporaryRoot, 'package');
  let hardened = false;
  try {
    await cp(sourceDirectory, packageDirectory, {
      recursive: true,
      dereference: false,
      errorOnExist: true,
    });
    await verifyRuntimePackage(packageDirectory, anchor);
    await harden(packageDirectory);
    hardened = true;
    await assertWriteDenied(packageDirectory);
    await verifyRuntimePackage(packageDirectory, anchor);
    await run(packageDirectory);
    await verifyRuntimePackage(packageDirectory, anchor);
  } finally {
    if (hardened) await restore(packageDirectory);
    if (dirname(temporaryRoot) !== scratchRoot) {
      throw new TypeError('refusing unsafe read-only smoke cleanup');
    }
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

async function assertWriteDenied(packageDirectory: string): Promise<void> {
  const marker = join(packageDirectory, '.write-probe');
  try {
    await writeFile(marker, 'must fail', { flag: 'wx' });
  } catch (error) {
    if (permissionDenied(error)) return;
    throw error;
  }
  throw new Error('installed runtime directory remained writable');
}

async function harden(root: string): Promise<void> {
  if (process.platform === 'win32') {
    const sid = currentWindowsSid();
    runIcacls(root, [
      '/inheritance:r',
      '/grant:r',
      `*${sid}:RX`,
      '/T',
      '/C',
      '/Q',
    ]);
    return;
  }
  await chmodTree(root, false);
}

async function restore(root: string): Promise<void> {
  try {
    if (process.platform === 'win32') {
      runIcacls(root, [
        '/grant',
        `*${currentWindowsSid()}:F`,
        '/T',
        '/C',
        '/Q',
      ]);
      return;
    }
    await chmodTree(root, true);
  } catch (error) {
    process.stderr.write(
      `warning: failed to restore package smoke permissions: ${String(error)}\n`,
    );
  }
}

async function chmodTree(root: string, writable: boolean): Promise<void> {
  const metadata = await lstat(root);
  if (metadata.isSymbolicLink()) {
    throw new TypeError('read-only smoke found a symbolic link');
  }
  if (metadata.isDirectory()) {
    if (writable) await chmod(root, 0o755);
    const entries = await readdir(root);
    for (const entry of entries) {
      await chmodTree(join(root, entry), writable);
    }
    if (!writable) await chmod(root, 0o555);
    return;
  }
  if (!metadata.isFile()) {
    throw new TypeError('read-only smoke found a non-regular file');
  }
  const executable = !root.endsWith('.json') && !root.endsWith('.sha256');
  await chmod(root, writable ? (executable ? 0o755 : 0o644) : (
    executable ? 0o555 : 0o444
  ));
}

function currentWindowsSid(): string {
  const result = spawnSync('whoami.exe', ['/user', '/fo', 'csv', '/nh'], {
    encoding: 'utf8',
    shell: false,
    windowsHide: true,
  });
  const match = /"(S-\d-(?:\d+-)+\d+)"/i.exec(result.stdout);
  if (result.status !== 0 || !match) {
    throw new Error('cannot resolve Windows identity for read-only smoke');
  }
  return match[1];
}

function runIcacls(root: string, arguments_: readonly string[]): void {
  const result = spawnSync('icacls.exe', [root, ...arguments_], {
    encoding: 'utf8',
    shell: false,
    windowsHide: true,
  });
  if (result.status !== 0) {
    throw new Error(`icacls failed: ${result.stderr || result.stdout}`);
  }
}

function permissionDenied(error: unknown): boolean {
  return error instanceof Error
    && 'code' in error
    && ['EACCES', 'EPERM', 'EROFS'].includes(String(error.code));
}
