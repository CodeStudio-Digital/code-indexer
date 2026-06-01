/**
 * Host shell detection for the integrated terminal's shell picker.
 *
 * `detectShells()` enumerates the shells actually installed on the
 * operator's machine so the UI can offer a real choice instead of
 * always spawning the system default. On Windows that means Windows
 * PowerShell, PowerShell 7 (pwsh), the Command Prompt, Git Bash, and
 * every installed WSL distro. On Unix it parses `/etc/shells` plus
 * `$SHELL`.
 *
 * Detection is best-effort and MUST NOT throw — a missing executable,
 * an absent `/etc/shells`, or a machine without WSL simply yields fewer
 * entries. The worst case degrades to a single fallback shell.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import type { TerminalShell } from '@mcp/api-bus';

export function detectShells(): TerminalShell[] {
  try {
    const list = process.platform === 'win32' ? detectWindows() : detectUnix();
    return list.length > 0 ? list : [fallbackShell()];
  } catch {
    return [fallbackShell()];
  }
}

function detectWindows(): TerminalShell[] {
  const out: TerminalShell[] = [];
  const sysRoot = process.env.SystemRoot ?? 'C:\\Windows';

  // Windows PowerShell — ships with every supported Windows version.
  const winPs = join(sysRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  out.push({
    id: 'powershell',
    label: 'Windows PowerShell',
    file: existsSync(winPs) ? winPs : 'powershell.exe',
    args: ['-NoLogo'],
  });

  // PowerShell 7+ (pwsh) — separate install, may be absent.
  const pwsh = findPwsh();
  if (pwsh) out.push({ id: 'pwsh', label: 'PowerShell 7', file: pwsh, args: ['-NoLogo'] });

  // Command Prompt.
  const cmd = process.env.ComSpec ?? join(sysRoot, 'System32', 'cmd.exe');
  out.push({ id: 'cmd', label: 'Command Prompt', file: cmd });

  // Git Bash (MSYS2 bash bundled with Git for Windows).
  const gitBash = findGitBash();
  if (gitBash) out.push({ id: 'git-bash', label: 'Git Bash', file: gitBash, args: ['-i', '-l'] });

  // WSL distros — one entry per installed distribution.
  for (const distro of listWslDistros()) {
    out.push({ id: `wsl:${distro}`, label: `WSL: ${distro}`, file: 'wsl.exe', args: ['-d', distro] });
  }

  return out;
}

function detectUnix(): TerminalShell[] {
  const seen = new Set<string>();
  const out: TerminalShell[] = [];
  const add = (file: string): void => {
    if (!file || seen.has(file)) return;
    seen.add(file);
    const name = file.split('/').pop() || file;
    // id is the full path (unique); label is the basename.
    out.push({ id: file, label: name, file, args: ['-l'] });
  };

  if (process.env.SHELL) add(process.env.SHELL);
  try {
    for (const line of readFileSync('/etc/shells', 'utf8').split('\n')) {
      const t = line.trim();
      if (t && !t.startsWith('#') && existsSync(t)) add(t);
    }
  } catch {
    /* no /etc/shells — fall back below */
  }
  if (out.length === 0) add('/bin/bash');
  return out;
}

/** Locate pwsh.exe via PATH, then the canonical install location. */
function findPwsh(): string | null {
  const onPath = findOnPath('pwsh.exe');
  if (onPath) return onPath;
  const candidates = [
    join(process.env.ProgramFiles ?? 'C:\\Program Files', 'PowerShell', '7', 'pwsh.exe'),
  ];
  return candidates.find((p) => existsSync(p)) ?? null;
}

/** Locate Git Bash (bash.exe) at the common Git-for-Windows install dirs. */
function findGitBash(): string | null {
  const pf = process.env.ProgramFiles ?? 'C:\\Program Files';
  const pf86 = process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)';
  const local = process.env.LOCALAPPDATA ?? '';
  const candidates = [
    join(pf, 'Git', 'bin', 'bash.exe'),
    join(pf86, 'Git', 'bin', 'bash.exe'),
    local ? join(local, 'Programs', 'Git', 'bin', 'bash.exe') : '',
  ].filter(Boolean);
  return candidates.find((p) => existsSync(p)) ?? null;
}

/**
 * List installed WSL distros via `wsl.exe --list --quiet`. The output is
 * UTF-16LE (a WSL quirk), so we decode the raw buffer rather than letting
 * Node assume UTF-8 — otherwise every distro name comes back interleaved
 * with NUL bytes.
 */
function listWslDistros(): string[] {
  try {
    const buf = execFileSync('wsl.exe', ['--list', '--quiet'], { timeout: 2000 });
    return buf
      .toString('utf16le')
      .split(/\r?\n/)
      .map((l) => l.replace(/\0/g, '').trim())
      .filter((l) => l.length > 0);
  } catch {
    return [];
  }
}

function findOnPath(exe: string): string | null {
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (!dir) continue;
    const full = join(dir, exe);
    if (existsSync(full)) return full;
  }
  return null;
}

function fallbackShell(): TerminalShell {
  if (process.platform === 'win32') {
    return { id: 'powershell', label: 'Windows PowerShell', file: 'powershell.exe', args: ['-NoLogo'] };
  }
  return { id: '/bin/bash', label: 'bash', file: process.env.SHELL ?? '/bin/bash', args: ['-l'] };
}
