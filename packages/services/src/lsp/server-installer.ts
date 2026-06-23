/**
 * On-demand LSP server installation — npm install into
 * `<dataDir>/lsp-servers/<id>@<version>/` via the proven runHostCommand
 * path (clean env, .cmd shims on Windows). Progress is an AsyncGenerator
 * (node-manager pattern): npm gives no byte counts, so frames carry the
 * log tail — indeterminate but honest.
 *
 * Freemium contract: this NEVER runs without an explicit user action
 * (the editor CTA / admin button call it).
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { lspServersBaseDir } from '@mcp/shared/utils/data-paths.js';
import { runHostCommand } from '../host-scaffold/run-host-command.js';
import { LSP_SERVER_REGISTRY, installDirFor, isInstalled, serverById, type LspServerDef } from './server-registry.js';

export type LspInstallProgress =
  | { phase: 'start'; serverId: string; version: string; targetDir: string }
  | { phase: 'log'; line: string }
  | { phase: 'done'; installDir: string }
  | { phase: 'error'; message: string };

export interface InstalledServerInfo {
  id: string;
  label: string;
  languages: string[];
  version: string;
  installed: boolean;
  sizeLabel: string;
}

export function listServers(baseDir = lspServersBaseDir()): InstalledServerInfo[] {
  return LSP_SERVER_REGISTRY.map((def) => ({
    id: def.id,
    label: def.label,
    languages: [...def.languages],
    version: def.install.version,
    installed: isInstalled(baseDir, def),
    sizeLabel: def.sizeLabel,
  }));
}

export async function* installServer(
  serverId: string,
  opts: { baseDir?: string; nodeBinDir?: string | null; signal?: AbortSignal } = {},
): AsyncGenerator<LspInstallProgress> {
  const def = serverById(serverId);
  if (!def) {
    yield { phase: 'error', message: `unknown LSP server: ${serverId}` };
    return;
  }
  const baseDir = opts.baseDir ?? lspServersBaseDir();
  const installDir = installDirFor(baseDir, def);
  yield { phase: 'start', serverId: def.id, version: def.install.version, targetDir: installDir };

  try {
    mkdirSync(installDir, { recursive: true });
    // A minimal manifest keeps npm from walking up to a parent package.json.
    writeFileSync(join(installDir, 'package.json'), JSON.stringify({ name: `lsp-${def.id}`, private: true }, null, 2));
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
    args: ['install', `${def.install.package}@${def.install.version}`, '--no-audit', '--no-fund', '--omit=dev', '--loglevel=info'],
    cwd: installDir,
    env,
    timeoutMs: 5 * 60_000,
    signal: opts.signal,
    onLog,
  });

  // Drain log lines while the install runs.
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
  if (!isInstalled(baseDir, def)) {
    yield { phase: 'error', message: 'npm reported success but the package entry was not found' };
    return;
  }
  yield { phase: 'done', installDir };
}

export function removeServer(serverId: string, baseDir = lspServersBaseDir()): boolean {
  const def = serverById(serverId);
  if (!def) return false;
  try {
    rmSync(installDirFor(baseDir, def), { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

export type { LspServerDef };
