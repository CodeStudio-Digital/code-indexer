/**
 * Podman-related preflight checks: the binary itself (blocking) and the
 * machine VM state on Windows/macOS (non-blocking — the wizard's machine-setup
 * action fixes it). Reuses the shared `probeBinaryVersion` and `listMachines`
 * so there's one definition of "is Podman live" / "what machines exist".
 */
import type { IShellPort } from '@mcp/code-agent/ports/shell-port.js';
import { probeBinaryVersion } from '../sandbox/drivers/probe.js';
import { listMachines } from '../podman-machine/machine-actions.js';
import type { CheckResult } from './types.js';

export async function checkPodman(shell: IShellPort): Promise<CheckResult> {
  const probe = await probeBinaryVersion(shell, 'podman');
  if (probe.present) {
    return {
      id: 'podman',
      label: 'Podman',
      status: 'ok',
      blocking: true,
      message: `Podman ${probe.version ?? ''}`.trim(),
      detail: { version: probe.version },
    };
  }
  return {
    id: 'podman',
    label: 'Podman',
    status: 'missing',
    blocking: true,
    message: 'Podman is not installed or not on PATH.',
    remediation: 'install-podman',
  };
}

export async function checkPodmanMachine(
  shell: IShellPort,
  platform: NodeJS.Platform,
  podmanPresent: boolean,
): Promise<CheckResult> {
  // Linux runs Podman natively — there is no machine VM to manage.
  if (platform === 'linux') {
    return mk('ok', false, 'Native Podman — no machine needed.');
  }
  if (!podmanPresent) {
    return mk('warn', false, 'Checked after Podman is installed.', 'init-machine');
  }
  const machines = await listMachines(shell);
  if (machines.length === 0) {
    return mk('missing', false, 'No Podman machine found — one needs to be created.', 'init-machine');
  }
  const running = machines.find((m) => m.Running);
  if (!running) {
    return {
      ...mk('warn', false, 'A Podman machine exists but is not running.', 'start-machine'),
      detail: { name: machines[0]?.Name },
    };
  }
  return {
    ...mk('ok', false, `Machine "${running.Name ?? '?'}" is running.`),
    detail: { name: running.Name },
  };
}

function mk(
  status: CheckResult['status'],
  blocking: boolean,
  message: string,
  remediation?: string,
): CheckResult {
  return { id: 'podman-machine', label: 'Podman machine', status, blocking, message, remediation };
}
