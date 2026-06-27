/**
 * Catalog of on-demand database drivers — the engines whose npm package is NOT
 * bundled (to keep the build small) and is fetched on first use into
 * `<dbDriversBaseDir>/<engine>@<version>/node_modules/...`. Mirrors the LSP
 * server registry. Versions are PINNED (one install per `engine@version`).
 *
 * The actual `npm install` runner lives in `@mcp/services` (it owns
 * runHostCommand); this module is pure path/fs + the registry data, so the
 * driver factory can resolve a lazily-installed module without importing
 * `@mcp/services`.
 */
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { dbDriversBaseDir } from '@mcp/shared/utils/data-paths.js';
import type { DbEngine, DbEngineKind } from './types.js';

export interface DbDriverDef {
  engine: DbEngine;
  kind: DbEngineKind;
  /** npm package to install + import. */
  package: string;
  version: string;
  /** Honest download-size hint for the consent CTA. */
  sizeLabel: string;
  /** True ⇒ pure-JS (no native rebuild); false ⇒ native/experimental. */
  pureJs: boolean;
}

export const DB_DRIVER_REGISTRY: readonly DbDriverDef[] = [
  { engine: 'oracle', kind: 'relational', package: 'oracledb', version: '6.9.0', sizeLabel: '~15 MB', pureJs: true },
  { engine: 'mongodb', kind: 'document', package: 'mongodb', version: '6.20.0', sizeLabel: '~10 MB', pureJs: true },
  { engine: 'redis', kind: 'keyvalue', package: 'ioredis', version: '5.8.1', sizeLabel: '~2 MB', pureJs: true },
] as const;

export function driverDefFor(engine: DbEngine): DbDriverDef | undefined {
  return DB_DRIVER_REGISTRY.find((d) => d.engine === engine);
}

/** Install dir for a driver (`<base>/<engine>@<version>`). */
export function driverInstallDir(def: DbDriverDef, baseDir: string = dbDriversBaseDir()): string {
  return join(baseDir, `${def.engine}@${def.version}`);
}

/** True when the pinned driver package is present in its install dir. */
export function isDriverInstalled(def: DbDriverDef, baseDir: string = dbDriversBaseDir()): boolean {
  return existsSync(join(driverInstallDir(def, baseDir), 'node_modules', def.package, 'package.json'));
}

/**
 * The import specifier the factory feeds to `await import(...)`: a `file://` URL
 * to the lazily-installed package when present, else the bare package name (so a
 * driver that happens to be a root dependency still resolves). Returns the bare
 * engine name for engines with no registry entry (let the import fail loudly).
 */
export function resolveDriverEntry(engine: DbEngine, baseDir: string = dbDriversBaseDir()): string {
  const def = driverDefFor(engine);
  if (!def) return engine;
  const installDir = driverInstallDir(def, baseDir);
  try {
    const req = createRequire(join(installDir, 'package.json'));
    return pathToFileURL(req.resolve(def.package)).href;
  } catch {
    return def.package;
  }
}
