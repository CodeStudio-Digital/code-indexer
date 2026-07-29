import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

interface AsarModule {
  extractFile(archivePath: string, filename: string): Buffer;
}

const ANCHOR_PATH = join(
  'dist',
  'apps',
  'electron',
  'native-agent-runtime-integrity.json',
);

export async function readInstalledRuntimeAnchor(
  archivePath: string,
): Promise<Buffer> {
  const asar = await loadAsar();
  return asar.extractFile(archivePath, ANCHOR_PATH);
}

async function loadAsar(): Promise<AsarModule> {
  const require = createRequire(import.meta.url);
  let resolved: string;
  try {
    resolved = require.resolve('@electron/asar');
  } catch {
    const builder = require.resolve('electron-builder');
    const appBuilder = require.resolve('app-builder-lib/package.json', {
      paths: [dirname(builder)],
    });
    resolved = require.resolve('@electron/asar', {
      paths: [dirname(appBuilder)],
    });
  }
  const loaded = await import(pathToFileURL(resolved).href);
  if (typeof loaded.extractFile !== 'function') {
    throw new TypeError('installed ASAR reader is unavailable');
  }
  return loaded as AsarModule;
}
