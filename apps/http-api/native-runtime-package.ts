import { readFile, readdir, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { VerifiedRuntimePackage } from '@mcp/agent-runtime-host';
import { nativeRuntimePaths } from './native-runtime-paths.js';

let runtimePackage: Promise<VerifiedRuntimePackage> | undefined;
export function loadProductNativeRuntimePackage(): Promise<VerifiedRuntimePackage> {
  return runtimePackage ??= (async () => {
    if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('Native package is not certified on this platform');
    const distRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
    const paths = nativeRuntimePaths(distRoot);
    const { parseRuntimePackageAnchor, verifyRuntimePackage } = await import('@mcp/agent-runtime-host');
    return verifyRuntimePackage(paths.packageDirectory, parseRuntimePackageAnchor(await readFile(paths.anchorPath)));
  })();
}

export function nativeRuntimeStorageRecovery(dataDirectory: string) {
  const rootPath = join(dataDirectory, 'native-sessions');
  return {
    async isPresent() {
      try { return (await stat(rootPath)).isDirectory(); }
      catch (cause) { if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return false; throw cause; }
    },
    async sessionIds() {
      return new Set((await readdir(rootPath, { withFileTypes: true }))
        .filter(entry => entry.isDirectory() && /^[a-f0-9-]{36}$/i.test(entry.name))
        .map(entry => entry.name));
    },
    async load() { return { rootPath, runtimePackage: await loadProductNativeRuntimePackage() }; },
  };
}
