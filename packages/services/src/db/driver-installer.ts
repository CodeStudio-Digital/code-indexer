/**
 * On-demand database-driver installation — `npm install <pkg>@<version>` into
 * `<dbDriversBaseDir>/<engine>@<version>/` via the proven runHostCommand path
 * (clean env, .cmd shims on Windows). Mirrors the LSP server installer; the
 * driver factory then `await import()`s the resolved entry (db-drivers
 * resolveDriverEntry).
 *
 * Freemium contract: NEVER runs without an explicit user action (the connection
 * dialog's "Install driver" CTA calls it).
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { dbDriversBaseDir } from '@mcp/shared/utils/data-paths.js';
import {
  DB_DRIVER_REGISTRY, driverDefFor, driverInstallDir, isDriverInstalled, type DbDriverDef, type DbEngine,
} from '@mcp/db-drivers';
import { runHostCommand } from '../host-scaffold/run-host-command.js';

export type DbDriverInstallProgress =
  | { phase: 'start'; engine: DbEngine; version: string; targetDir: string }
  | { phase: 'log'; line: string }
  | { phase: 'done'; installDir: string }
  | { phase: 'error'; message: string };

export interface DbDriverStatus {
  engine: DbEngine;
  package: string;
  version: string;
  installed: boolean;
  sizeLabel: string;
  pureJs: boolean;
}

export function listDbDriverStatus(baseDir = dbDriversBaseDir()): DbDriverStatus[] {
  return DB_DRIVER_REGISTRY.map((def) => ({
    engine: def.engine,
    package: def.package,
    version: def.version,
    installed: isDriverInstalled(def, baseDir),
    sizeLabel: def.sizeLabel,
    pureJs: def.pureJs,
  }));
}

export async function* installDbDriver(
  engine: DbEngine,
  opts: { baseDir?: string; nodeBinDir?: string | null; signal?: AbortSignal } = {},
): AsyncGenerator<DbDriverInstallProgress> {
  const def: DbDriverDef | undefined = driverDefFor(engine);
  if (!def) {
    yield { phase: 'error', message: `no installable driver for engine: ${engine}` };
    return;
  }
  const baseDir = opts.baseDir ?? dbDriversBaseDir();
  const installDir = driverInstallDir(def, baseDir);
  yield { phase: 'start', engine: def.engine, version: def.version, targetDir: installDir };

  try {
    mkdirSync(installDir, { recursive: true });
    // A minimal manifest keeps npm from walking up to a parent package.json.
    writeFileSync(join(installDir, 'package.json'), JSON.stringify({ name: `db-driver-${def.engine}`, private: true }, null, 2));
  } catch (err) {
    yield { phase: 'error', message: `mkdir failed: ${err instanceof Error ? err.message : err}` };
    return;
  }

  const lines: string[] = [];
  let pump: (() => void) | null = null;
  const onLog = (_stream: 'stdout' | 'stderr', chunk: string): void => {
    for (const line of chunk.split(/\r?\n/)) {
      if (line.trim()) lines.push(line.trim());
    }
    pump?.();
  };

  const env: NodeJS.ProcessEnv = { ...process.env };
  if (opts.nodeBinDir) env.PATH = `${opts.nodeBinDir}${delimiter}${env.PATH ?? ''}`;

  const run = runHostCommand({
    program: 'npm',
    args: ['install', `${def.package}@${def.version}`, '--no-audit', '--no-fund', '--omit=dev', '--loglevel=info'],
    cwd: installDir,
    env,
    timeoutMs: 5 * 60_000,
    signal: opts.signal,
    onLog,
  });

  let finished = false;
  void run.finally(() => { finished = true; pump?.(); });
  while (!finished) {
    if (lines.length === 0) {
      await new Promise<void>((resolve) => { pump = resolve; });
      pump = null;
    }
    while (lines.length > 0) yield { phase: 'log', line: lines.shift()! };
  }
  while (lines.length > 0) yield { phase: 'log', line: lines.shift()! };

  const result = await run;
  if (!result.ok) {
    yield { phase: 'error', message: `npm install failed (exit ${result.exitCode}${result.reason ? `, ${result.reason}` : ''}): ${result.stderrTail.slice(-400)}` };
    return;
  }
  if (!isDriverInstalled(def, baseDir)) {
    yield { phase: 'error', message: 'npm reported success but the driver package was not found' };
    return;
  }
  yield { phase: 'done', installDir };
}

export function removeDbDriver(engine: DbEngine, baseDir = dbDriversBaseDir()): boolean {
  const def = driverDefFor(engine);
  if (!def) return false;
  try {
    rmSync(driverInstallDir(def, baseDir), { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}
