import { createRequire } from 'node:module';
import { basename, dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const ENABLE = 49;
const ASAR_INTEGRITY_FUSE = 4;
const ONLY_ASAR_FUSE = 5;

interface FusesModule {
  getCurrentFuseWire(
    executable: string,
  ): Promise<Record<number, number> & { version: string }>;
}

export async function verifyInstalledAsarFuses(
  appDirectory: string,
): Promise<void> {
  if (process.platform !== 'win32' && process.platform !== 'darwin') return;
  const executable = process.platform === 'win32'
    ? join(appDirectory, 'CodeStudio.exe')
    : join(
      appDirectory,
      'Contents',
      'MacOS',
      basename(appDirectory, '.app'),
    );
  const fuses = await loadFuses();
  const wire = await fuses.getCurrentFuseWire(executable);
  if (
    wire.version !== '1'
    || wire[ASAR_INTEGRITY_FUSE] !== ENABLE
    || wire[ONLY_ASAR_FUSE] !== ENABLE
  ) throw new Error('installed Electron ASAR integrity fuses are not enabled');
}

async function loadFuses(): Promise<FusesModule> {
  const require = createRequire(import.meta.url);
  let resolved: string;
  try {
    resolved = require.resolve('@electron/fuses');
  } catch {
    const builder = require.resolve('electron-builder');
    const appBuilder = require.resolve('app-builder-lib/package.json', {
      paths: [dirname(builder)],
    });
    resolved = require.resolve('@electron/fuses', {
      paths: [dirname(appBuilder)],
    });
  }
  const loaded = await import(pathToFileURL(resolved).href);
  if (typeof loaded.getCurrentFuseWire !== 'function') {
    throw new TypeError('Electron fuse reader is unavailable');
  }
  return loaded as FusesModule;
}
