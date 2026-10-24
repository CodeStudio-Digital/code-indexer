import type { LspInstallProgress } from './install-progress.js';
export type { LspInstallProgress } from './install-progress.js';
/**
 * On-demand LSP server installation into
 * `<dataDir>/lsp-servers/<id>@<version>/`. Dispatches on install.kind:
 * npm packages go through the proven runHostCommand path (clean env,
 * .cmd shims on Windows); native binaries through binary-installer
 * (download + sha256 + extract). Progress is an AsyncGenerator
 * (node-manager pattern): npm gives no byte counts, so frames carry the
 * log tail — indeterminate but honest.
 *
 * Freemium contract: this NEVER runs without an explicit user action
 * (the editor CTA / admin button call it).
 */
import { randomUUID } from 'node:crypto';
import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { lspServersBaseDir } from '@mcp/shared/utils/data-paths.js';
import { runHostCommand } from '../host-scaffold/run-host-command.js';
import { installBinaryServer } from './binary-installer.js';
import {
  allLspServers,
  installDirFor,
  isInstalled,
  serverById,
  validateNpmServerInstall,
  type LspServerDef,
} from './server-registry.js';


export interface InstalledServerInfo {
  id: string;
  familyId?: string;
  profileId?: string;
  label: string;
  languages: string[];
  version: string;
  installed: boolean;
  sizeLabel: string;
  supportTier?: LspServerDef['supportTier'];
}

export function listServers(baseDir = lspServersBaseDir()): InstalledServerInfo[] {
  return allLspServers().map((def) => ({
    id: def.id,
    familyId: def.familyId,
    profileId: def.profileId,
    label: def.label,
    languages: [...def.languages],
    version: def.install.version,
    installed: isInstalled(baseDir, def),
    sizeLabel: def.sizeLabel,
    supportTier: def.supportTier,
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

  // Native binaries: download/verify/extract — no npm, no Node involved.
  if (def.install.kind === 'binary') {
    yield* installBinaryServer(def, installDir, { signal: opts.signal });
    return;
  }

  if (isInstalled(baseDir, def)) {
    yield { phase: 'done', installDir };
    return;
  }

  mkdirSync(baseDir, { recursive: true });
  const stagingDir = join(baseDir, `.staging-${safeSegment(def.id)}-${process.pid}-${randomUUID()}`);
  try {
    mkdirSync(stagingDir, { recursive: true });
    // A minimal manifest keeps npm from walking up to a parent package.json.
    writeFileSync(join(stagingDir, 'package.json'), JSON.stringify({ name: `lsp-${safeSegment(def.id)}`, private: true }, null, 2));
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
    cwd: stagingDir,
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
    cleanupStaging(stagingDir);
    yield { phase: 'error', message: `npm install failed (exit ${result.exitCode}${result.reason ? `, ${result.reason}` : ''}): ${result.stderrTail.slice(-400)}` };
    return;
  }
  const validationError = validateNpmServerInstall(stagingDir, def);
  if (validationError) {
    cleanupStaging(stagingDir);
    yield { phase: 'error', message: validationError };
    return;
  }
  writeInstallReceipt(stagingDir, def);
  try {
    // A concurrent installer may have won while this staging tree was built.
    if (validateNpmServerInstall(installDir, def) === null) {
      cleanupStaging(stagingDir);
    } else {
      rmSync(installDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      renameSync(stagingDir, installDir);
    }
  } catch (err) {
    cleanupStaging(stagingDir);
    yield { phase: 'error', message: `finalize failed: ${err instanceof Error ? err.message : String(err)}` };
    return;
  }
  yield { phase: 'done', installDir };
}

const RECEIPT_FILE = '.mcp-lsp-install.json';

function safeSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 96);
}

function writeInstallReceipt(root: string, def: LspServerDef): void {
  writeFileSync(join(root, RECEIPT_FILE), JSON.stringify({
    schema: 1,
    serverId: def.id,
    familyId: def.familyId,
    profileId: def.profileId,
    package: def.install.kind === 'npm' ? def.install.package : undefined,
    version: def.install.version,
    installedAt: new Date().toISOString(),
  }, null, 2));
}

function cleanupStaging(stagingDir: string): void {
  try { rmSync(stagingDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); } catch { /* best effort */ }
}

export function removeServer(serverId: string, baseDir = lspServersBaseDir()): boolean {
  const def = serverById(serverId);
  if (!def) return false;
  try {
    // Windows can release a terminated native executable a few milliseconds
    // after the child exit event. Let fs.rm absorb that transient EPERM/EBUSY.
    const removeOptions = { recursive: true, force: true, maxRetries: 5, retryDelay: 100 } as const;
    rmSync(installDirFor(baseDir, def), removeOptions);
    rmSync(join(baseDir, '.workspaces', `${def.id}@${def.install.version}`), removeOptions);
    return true;
  } catch {
    return false;
  }
}

export type { LspServerDef };
