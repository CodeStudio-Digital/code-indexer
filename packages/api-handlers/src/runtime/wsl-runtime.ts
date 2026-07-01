/**
 * WSL transport + detection for MCP-managed runtimes living INSIDE a distro.
 *
 * Everything here shells into the distro via `wsl.exe -d <distro> -- bash -lc`.
 * Detection lists ONLY our managed installs under `~/.mcp/runtimes/<kind>` (the
 * point of the feature is to not depend on the distro's own toolchain), so it's
 * a single fast `ls` — no probing of nvm/apt/pyenv. Best-effort: a missing
 * distro / `wsl.exe` (non-Windows host) degrades to an empty list.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Runtime, RuntimeKind } from '@mcp/api-bus';
import { wslManagedBinDir } from './wsl-paths.js';

const execFileAsync = promisify(execFile);

const KIND_LABEL: Record<RuntimeKind, string> = { node: 'Node', php: 'PHP', python: 'Python' };

/**
 * Run a bash login command inside `distro`; returns trimmed stdout, or '' on
 * any failure (missing distro, non-zero exit, no wsl.exe). `bash -lc` loads the
 * profile so the distro PATH is present.
 */
export async function wslBash(distro: string, script: string, timeoutMs = 15_000): Promise<string> {
  try {
    const { stdout } = await execFileAsync('wsl.exe', ['-d', distro, '--', 'bash', '-lc', script], {
      encoding: 'utf8',
      timeout: timeoutMs,
      maxBuffer: 1 << 22,
      windowsHide: true,
    });
    return stdout.trim();
  } catch {
    return '';
  }
}

/** CPU arch + libc of a distro — picks the right portable build at install. */
export interface WslPlatform {
  /** Node/PBS asset arch token source. */
  arch: 'x86_64' | 'aarch64';
  /** glibc ('gnu') vs musl/Alpine ('musl'). v1 supports gnu only. */
  libc: 'gnu' | 'musl';
}

/**
 * Detect the distro's arch + libc. Returns null when the distro can't be
 * reached. `uname -m` gives the arch; the `ldd --version` banner reveals musl
 * (Alpine) vs glibc.
 */
export async function detectWslPlatform(distro: string): Promise<WslPlatform | null> {
  const out = await wslBash(distro, 'uname -m; (ldd --version 2>&1 | head -1) || true');
  if (!out) return null;
  const lines = out.split(/\r?\n/);
  const machine = (lines[0] ?? '').trim();
  const arch: WslPlatform['arch'] = /aarch64|arm64/i.test(machine) ? 'aarch64' : 'x86_64';
  const libc: WslPlatform['libc'] = /musl/i.test(out) ? 'musl' : 'gnu';
  return { arch, libc };
}

/**
 * List the MCP-managed runtimes of `kind` already installed in `distro`. The
 * version folder name IS the version (we control the layout), so no per-binary
 * probe is needed.
 */
export async function detectWslRuntimes(kind: RuntimeKind, distro: string): Promise<Runtime[]> {
  const out = await wslBash(distro, `ls -1 "$HOME/.mcp/runtimes/${kind}" 2>/dev/null`);
  if (!out) return [];
  const versions = out
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && /^\d/.test(s));
  return versions.map((version) => ({
    kind,
    id: `managed:${version}`,
    label: `${KIND_LABEL[kind]} ${version} (WSL: ${distro})`,
    version,
    binDir: wslManagedBinDir(kind, version),
    source: 'managed',
    isManaged: true,
  }));
}
