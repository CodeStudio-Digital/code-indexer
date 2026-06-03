/**
 * Validator sandbox provisioning — materializes a real shadcn + Vite project
 * under `{dataDir}/training/sandbox/<profile>/` (node_modules live HERE, in the
 * app data dir, never in the repo or a user project). One-time `npm install` +
 * `shadcn add --all`; a `.ready` marker short-circuits later runs.
 *
 * Resilient: if `shadcn add` fails (offline/CLI), the sandbox still has the
 * base + deps, and the validator's stub layer covers missing components.
 */
import { access, mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { IShellPort } from '@mcp/code-agent/ports/shell-port.js';
import type { StackProfile } from './stack-profiles.js';
import { baseFiles, packageJson } from './sandbox-template.js';

const INSTALL_TIMEOUT_MS = 600_000;
const inflight = new Map<string, Promise<string>>();

export function sandboxPath(dataDir: string, profileId: string): string {
  return join(dataDir, 'training', 'sandbox', profileId);
}

async function exists(p: string): Promise<boolean> {
  try { await access(p); return true; } catch { return false; }
}

export type StatusFn = (msg: string) => void;

async function provision(
  dir: string, profile: StackProfile, shell: IShellPort, onStatus?: StatusFn,
): Promise<string> {
  onStatus?.('provisioning sandbox: writing base files');
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'package.json'), packageJson(), 'utf-8');
  for (const [rel, content] of Object.entries(baseFiles())) {
    const full = join(dir, rel);
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, content, 'utf-8');
  }

  onStatus?.('provisioning sandbox: npm install (one-time, ~1-2 min)');
  const install = await shell.exec('npm install --no-audit --no-fund', { cwd: dir, timeoutMs: INSTALL_TIMEOUT_MS });
  if ((install.exitCode ?? 1) !== 0) {
    throw new Error(`sandbox npm install failed: ${install.stderr.slice(0, 500)}`);
  }

  if (profile.sandbox === 'shadcn-vite') {
    onStatus?.('provisioning sandbox: shadcn add --all');
    // Best-effort — stubs cover anything this doesn't install.
    await shell.exec('npx --yes shadcn@latest add --all --yes --overwrite', {
      cwd: dir, timeoutMs: INSTALL_TIMEOUT_MS,
    });
  }

  await writeFile(join(dir, '.ready'), new Date(0).toISOString(), 'utf-8');
  onStatus?.('sandbox ready');
  return dir;
}

/** Return the sandbox dir for a profile, provisioning it on first use. */
export function ensureSandbox(
  dataDir: string, profile: StackProfile, shell: IShellPort, onStatus?: StatusFn,
): Promise<string> {
  const dir = sandboxPath(dataDir, profile.id);
  const pending = inflight.get(dir);
  if (pending) return pending;

  const task = (async () => {
    if (await exists(join(dir, '.ready'))) return dir;
    return provision(dir, profile, shell, onStatus);
  })().finally(() => inflight.delete(dir));

  inflight.set(dir, task);
  return task;
}
