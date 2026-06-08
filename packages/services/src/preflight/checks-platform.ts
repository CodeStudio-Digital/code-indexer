/**
 * Non-Podman host checks: WSL2 (Windows only), Git, and free disk space.
 * All non-blocking — they surface warnings, never gate the wizard.
 */
import { statfs } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { IShellPort } from '@mcp/code-agent/ports/shell-port.js';
import { probeBinaryVersion } from '../sandbox/drivers/probe.js';
import type { CheckResult } from './types.js';

const MIN_FREE_BYTES = 2 * 1024 * 1024 * 1024; // 2 GB

/**
 * WSL2 presence (Windows only). Advisory, NOT blocking: `wsl --install` needs
 * admin + reboot (out of guided scope), and Podman Desktop ships its own WSL
 * backend, so the real gate is the Podman machine — not this.
 */
export async function checkWsl2(shell: IShellPort, platform: NodeJS.Platform): Promise<CheckResult> {
  const mk = (status: CheckResult['status'], message: string, remediation?: string): CheckResult => ({
    id: 'wsl2',
    label: 'WSL2',
    status,
    blocking: false,
    message,
    remediation,
  });

  if (platform !== 'win32') return mk('ok', 'Not required on this OS.');
  try {
    const status = await shell.run('wsl', ['--status'], { cwd: process.cwd(), encoding: 'utf-8' });
    if (status.exitCode !== 0) {
      return mk('warn', 'WSL2 is required for Podman on Windows. Run `wsl --install` in an elevated terminal, then reboot.', 'install-wsl2');
    }
    // `wsl` emits UTF-16LE; read as utf-8 it carries non-ASCII garbage bytes.
    // Strip everything that is not printable ASCII (keep CR/LF), then a stray
    // letter means at least one distro is listed.
    const list = await shell.run('wsl', ['-l', '-q'], { cwd: process.cwd(), encoding: 'utf-8' });
    const cleaned = list.stdout.replace(/[^ -~\r\n]/g, '');
    const hasDistro = /[A-Za-z]/.test(cleaned);
    if (!hasDistro) {
      return mk('warn', 'WSL2 is installed but has no Linux distro. Podman Desktop installs its own.', 'wsl-distro');
    }
    return mk('ok', 'WSL2 is installed.');
  } catch {
    return mk('warn', 'Could not query WSL. If Podman fails, run `wsl --install` (admin) and reboot.', 'install-wsl2');
  }
}

export async function checkGit(shell: IShellPort): Promise<CheckResult> {
  const probe = await probeBinaryVersion(shell, 'git', ['--version']);
  if (probe.present) {
    return { id: 'git', label: 'Git', status: 'ok', blocking: false, message: `Git ${probe.version ?? ''}`.trim(), detail: { version: probe.version } };
  }
  return { id: 'git', label: 'Git', status: 'warn', blocking: false, message: 'Git is not on PATH. Cloning and the New Project wizard need it.', remediation: 'install-git' };
}

export async function checkDisk(dbPath: string): Promise<CheckResult> {
  try {
    const stats = await statfs(dirname(dbPath));
    const freeBytes = stats.bavail * stats.bsize;
    const gb = (freeBytes / 1024 ** 3).toFixed(1);
    if (freeBytes < MIN_FREE_BYTES) {
      return { id: 'disk', label: 'Disk space', status: 'warn', blocking: false, message: `Low free space (${gb} GB) in the data folder.`, remediation: 'free-disk', detail: { freeBytes } };
    }
    return { id: 'disk', label: 'Disk space', status: 'ok', blocking: false, message: `${gb} GB free.`, detail: { freeBytes } };
  } catch {
    // Never block on an unreadable statfs (some FUSE/overlay mounts fail it).
    return { id: 'disk', label: 'Disk space', status: 'ok', blocking: false, message: 'Disk space check skipped.' };
  }
}
