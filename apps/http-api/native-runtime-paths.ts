import { basename, dirname, join, resolve } from 'node:path';

/** Electron Node mode need not expose resourcesPath. Derive the sibling
 * native package from the actual ASAR location, never from the working dir. */
export function nativeRuntimePaths(distRoot: string) {
  const root = resolve(distRoot);
  const archive = dirname(root);
  const resources = basename(root) === 'dist' && basename(archive) === 'app.asar'
    ? dirname(archive) : root;
  return {
    packageDirectory: join(resources, 'native-agent-runtime', 'x86_64-pc-windows-msvc'),
    anchorPath: join(root, 'apps', 'electron', 'native-agent-runtime-integrity.json'),
  };
}
