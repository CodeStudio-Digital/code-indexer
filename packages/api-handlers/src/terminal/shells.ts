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

import { execFile } from 'node:child_process';
import { access } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import type { RuntimeTarget, TerminalShell } from '@mcp/api-bus';

export async function detectShells(): Promise<TerminalShell[]> {
  try {
    const list = process.platform === 'win32'
      ? [...await windowsShells(), ...await wslShells()] : detectUnix();
    return list.length > 0 ? list : [fallbackShell()];
  } catch {
    return [fallbackShell()];
  }
}

async function windowsShells(only?: string): Promise<TerminalShell[]> {
  const out: TerminalShell[] = [];
  const sysRoot = process.env.SystemRoot ?? 'C:\\Windows';

  // Windows PowerShell — ships with every supported Windows version.
  const winPs = join(sysRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  if (!only || only === 'powershell') out.push({
    id: 'powershell',
    label: 'Windows PowerShell',
    file: await firstAvailable([winPs]) ?? 'powershell.exe',
    args: ['-NoLogo'],
  });

  // PowerShell 7+ (pwsh) — separate install, may be absent.
  const pwsh = !only || only === 'pwsh' ? await findPwsh() : null;
  if (pwsh) out.push({ id: 'pwsh', label: 'PowerShell 7', file: pwsh, args: ['-NoLogo'] });

  // Command Prompt.
  const cmd = process.env.ComSpec ?? join(sysRoot, 'System32', 'cmd.exe');
  if (!only || only === 'cmd') out.push({ id: 'cmd', label: 'Command Prompt', file: cmd });

  // Git Bash (MSYS2 bash bundled with Git for Windows).
  const gitBash = !only || only === 'git-bash' ? await findGitBash() : null;
  if (gitBash) out.push({ id: 'git-bash', label: 'Git Bash', file: gitBash, args: ['-i', '-l'] });

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
function findPwsh(): Promise<string | null> {
  const candidates = [
    ...(process.env.PATH ?? '').split(delimiter).filter(Boolean).map(dir => join(dir, 'pwsh.exe')),
    join(process.env.ProgramFiles ?? 'C:\\Program Files', 'PowerShell', '7', 'pwsh.exe'),
  ];
  return firstAvailable(candidates);
}

/** Locate Git Bash (bash.exe) at the common Git-for-Windows install dirs. */
function findGitBash(): Promise<string | null> {
  const pf = process.env.ProgramFiles ?? 'C:\\Program Files';
  const pf86 = process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)';
  const local = process.env.LOCALAPPDATA ?? '';
  const candidates = [
    join(pf, 'Git', 'bin', 'bash.exe'),
    join(pf86, 'Git', 'bin', 'bash.exe'),
    local ? join(local, 'Programs', 'Git', 'bin', 'bash.exe') : '',
  ].filter(Boolean);
  return firstAvailable(candidates);
}

/**
 * List installed WSL distros via `wsl.exe --list --quiet`. The output is
 * UTF-16LE (a WSL quirk), so we decode the raw buffer rather than letting
 * Node assume UTF-8 — otherwise every distro name comes back interleaved
 * with NUL bytes.
 */
let wslListing: Promise<TerminalShell[]> | undefined;
let wslCache: { shells: TerminalShell[]; expires: number } | undefined;
function wslShells(): Promise<TerminalShell[]> {
  if (wslCache && wslCache.expires > Date.now()) return Promise.resolve(wslCache.shells);
  wslListing ??= new Promise<TerminalShell[]>((done) => {
    execFile('wsl.exe', ['--list', '--quiet'], { timeout: 2000, windowsHide: true, encoding: 'buffer' }, (error, buf) => {
      if (error) { done([]); return; }
      const names = buf.toString('utf16le').split(/\r?\n/).map(line => line.replace(/\0/g, '').trim()).filter(Boolean);
      const shells = names.map(distro => ({ id: `wsl:${distro}`, label: `WSL: ${distro}`, file: 'wsl.exe', args: ['-d', distro] }));
      wslCache = { shells, expires: Date.now() + 30_000 };
      done(shells);
    });
  }).finally(() => { wslListing = undefined; });
  return wslListing;
}

async function firstAvailable(candidates: string[]): Promise<string | null> {
  for (const candidate of candidates) {
    try { await access(candidate); return candidate; } catch { /* try the next location */ }
  }
  return null;
}

/**
 * Resolve a stored shell id (from the picker) back to a spawnable
 * `{ file, args }`. Custom shells encode their path in the id
 * (`custom:<path>`), so they resolve without the renderer's localStorage.
 * Returns null for the system default (no override) or an unknown id.
 */
export async function resolveShellById(id: string | null | undefined): Promise<TerminalShell | null> {
  if (!id || id === 'system') return null;
  if (id.startsWith('custom:')) {
    const file = id.slice('custom:'.length);
    return { id, label: file.split(/[\\/]/).pop() || file, file };
  }
  const shells = process.platform !== 'win32' ? detectUnix()
    : id.startsWith('wsl:') ? await wslShells() : await windowsShells(id);
  return shells.find(shell => shell.id === id) ?? null;
}

/**
 * Classify a resolved shell into its runtime execution target. A `wsl.exe`
 * shell (its distro carried in `args` as `['-d', <distro>]`) runs commands
 * INSIDE that Linux distro, so its runtimes are Linux builds — anything else
 * (PowerShell, cmd, Git Bash — which is Windows-native bash) is the `host`.
 * Drives target-aware runtime injection at spawn (see runtime-resolve.ts).
 */
export function targetForShell(shell: { file: string; args?: string[] } | null | undefined): RuntimeTarget {
  if (!shell?.file) return { kind: 'host' };
  const base = shell.file.toLowerCase();
  if (!/wsl(\.exe)?$/.test(base)) return { kind: 'host' };
  const args = shell.args ?? [];
  const i = args.findIndex((a) => a === '-d' || a === '--distribution');
  const distro = i >= 0 ? args[i + 1] : undefined;
  return distro ? { kind: 'wsl', distro } : { kind: 'host' };
}

function fallbackShell(): TerminalShell {
  if (process.platform === 'win32') {
    return { id: 'powershell', label: 'Windows PowerShell', file: 'powershell.exe', args: ['-NoLogo'] };
  }
  return { id: '/bin/bash', label: 'bash', file: process.env.SHELL ?? '/bin/bash', args: ['-l'] };
}
