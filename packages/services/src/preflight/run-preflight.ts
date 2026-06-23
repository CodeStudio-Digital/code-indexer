/**
 * Preflight orchestrator — runs every host check and assembles a report.
 *
 * Podman is probed first because its presence gates the machine + image
 * checks. The rest run concurrently. Each check is wrapped so one failing
 * probe degrades to a single `error` result instead of throwing the whole
 * report — first-run must always render something actionable.
 */
import { defaultLocalShellPort } from '@mcp/code-agent/ports/shell-port.js';
import { checkPodman, checkPodmanMachine } from './checks-podman.js';
import { checkWsl2, checkGit, checkDisk } from './checks-platform.js';
import { checkSandboxImage } from './checks-image.js';
import type { CheckId, CheckResult, PreflightDeps, PreflightReport } from './types.js';

async function safe(id: CheckId, label: string, run: () => Promise<CheckResult>): Promise<CheckResult> {
  try {
    return await run();
  } catch (err) {
    return { id, label, status: 'error', blocking: false, message: err instanceof Error ? err.message : String(err) };
  }
}

export async function runPreflight(deps: PreflightDeps): Promise<PreflightReport> {
  const shell = deps.shell ?? defaultLocalShellPort();
  const platform = process.platform;

  const podman = await safe('podman', 'Podman', () => checkPodman(shell));
  const podmanPresent = podman.status === 'ok';

  const [machine, wsl2, git, disk, image] = await Promise.all([
    safe('podman-machine', 'Podman machine', () => checkPodmanMachine(shell, platform, podmanPresent)),
    safe('wsl2', 'WSL2', () => checkWsl2(shell, platform)),
    safe('git', 'Git', () => checkGit(shell)),
    safe('disk', 'Disk space', () => checkDisk(deps.dbPath)),
    safe('sandbox-image', 'Sandbox image', () => checkSandboxImage(shell, podmanPresent)),
  ]);

  const checks: CheckResult[] = [podman, machine, wsl2, git, disk, image];
  const blocked = checks.some((c) => c.blocking && (c.status === 'missing' || c.status === 'error'));
  return { platform, ok: !blocked, blocked, checks, generatedAt: new Date().toISOString() };
}
