import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface DrawioVendorLocations {
  overrideDirectory?: string;
  resourcesDirectory?: string;
  sourceRoots: readonly string[];
}

/** Locate the same offline asset for HTTP and Electron without importing a route. */
export function findDrawioVendorDir(locations: DrawioVendorLocations): string | null {
  const candidates = [
    locations.overrideDirectory,
    locations.resourcesDirectory && join(locations.resourcesDirectory, 'drawio'),
    ...locations.sourceRoots.map(root => join(root, 'apps/http-api/vendor/drawio')),
  ];
  return candidates.find((candidate): candidate is string => !!candidate && existsSync(join(candidate, 'index.html'))) ?? null;
}

let cachedDirectory: string | null | undefined;
export function drawioVendorDir(): string | null {
  if (cachedDirectory !== undefined) return cachedDirectory;
  const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
  cachedDirectory = findDrawioVendorDir({
    overrideDirectory: process.env.MCP_DRAWIO_DIR,
    resourcesDirectory: process.resourcesPath,
    sourceRoots: [sourceRoot, resolve(sourceRoot, '..')],
  });
  return cachedDirectory;
}
