/**
 * Install/uninstall MCP-managed runtimes INSIDE a WSL distro — the Linux mirror
 * of the Windows managed model. Strategy: download the portable build on the
 * WINDOWS side (robust fetch + progress), then extract it inside the distro from
 * the temp file's `/mnt/...` path into `~/.mcp/runtimes/<kind>/<version>` (native
 * ext4 → correct symlinks + exec bits, no apt/sudo). Per-terminal PATH injection
 * makes the version exist only in that terminal (see runtime-resolve.ts).
 *
 * Sources (no official portable Linux build from php.net/python.org):
 *   - Node:   official nodejs.org linux tarball.
 *   - Python: python-build-standalone (astral-sh), relocatable `install_only`.
 *   - Java:   Eclipse Temurin linux tarball (Adoptium API).
 *   - .NET:   official SDK linux tarball (FLAT archive — extracted WITHOUT
 *             --strip-components; the version dir is the dotnet root).
 *   - PHP:    deferred (Fase 2b — static-php); throws for now.
 */

import { rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { ApiError, type InstallProgress, type RuntimeKind, type RuntimeRelease } from '@mcp/api-bus';
import { downloadFile } from './runtime-shared.js';
import { listAvailable as listNodeReleases } from './node-manager.js';
import { archiveFor as jdkArchiveFor, listReleases as listJdkReleases } from './jdk-manager.js';
import { listReleases as listDotnetReleases, sdkArchiveUrl } from './dotnet-manager.js';
import { detectWslPlatform, detectWslRuntimes, type WslPlatform } from './wsl-runtime.js';
import { toWslMntPath, wslManagedDir } from './wsl-paths.js';
import { assertRuntimeVersion } from './runtime-version.js';
import type { DownloadDigest } from './runtime-shared.js';

const execFileAsync = promisify(execFile);
const PBS_LATEST = 'https://api.github.com/repos/astral-sh/python-build-standalone/releases/latest';

const WSL_KINDS = new Set<RuntimeKind>(['node', 'python', 'java', 'dotnet']);

/** Adoptium arch token for a distro platform. */
const jdkArch = (plat: WslPlatform): 'x64' | 'aarch64' => (plat.arch === 'aarch64' ? 'aarch64' : 'x64');
/** .NET rid for a distro platform (glibc only — musl gated at install). */
const dotnetRid = (plat: WslPlatform): string => `linux-${plat.arch === 'aarch64' ? 'arm64' : 'x64'}`;

/** Releases of `kind` installable into a WSL distro. */
export async function listWslReleases(kind: RuntimeKind, distro: string): Promise<RuntimeRelease[]> {
  if (kind === 'node') return listNodeReleases();
  if (kind === 'dotnet') return listDotnetReleases(); // channel list is platform-independent
  if (kind === 'python' || kind === 'java') {
    const plat = (await detectWslPlatform(distro)) ?? { arch: 'x86_64' as const, libc: 'gnu' as const };
    if (kind === 'java') return listJdkReleases('linux', jdkArch(plat));
    return (await pbsAssets(plat)).map((a) => ({ version: a.version, label: `Python ${a.version} (standalone)` }));
  }
  throw new ApiError('unsupported', 400, `WSL ${kind} install is not supported yet`);
}

/** Archive URL for `kind`@`version` on the distro platform. */
async function wslArchive(
  kind: RuntimeKind,
  version: string,
  plat: WslPlatform,
): Promise<{ url: string; digest?: DownloadDigest }> {
  if (kind === 'node') return { url: nodeUrl(version, plat) };
  if (kind === 'python') return { url: await pythonUrl(version, plat) };
  if (kind === 'java') {
    const asset = await jdkArchiveFor(version, 'linux', jdkArch(plat));
    return { url: asset.url, digest: { algorithm: 'sha256', expected: asset.sha256 } };
  }
  const asset = await sdkArchiveUrl(version, dotnetRid(plat));
  return { url: asset.url, digest: { algorithm: 'sha512', expected: asset.sha512 } };
}

/** Download + extract a managed runtime inside the distro, yielding progress. */
export async function* installWslRuntime(
  kind: RuntimeKind,
  version: string,
  distro: string,
): AsyncGenerator<InstallProgress> {
  if (!WSL_KINDS.has(kind)) {
    throw new ApiError('unsupported', 400, `WSL ${kind} install is not supported yet`);
  }
  assertRuntimeVersion(version);
  const plat = await detectWslPlatform(distro);
  if (!plat) throw new ApiError('internal', 500, `could not reach WSL distro "${distro}"`);
  if (plat.libc === 'musl') {
    throw new ApiError('unsupported', 400, `musl/Alpine distros are not supported yet (${distro})`);
  }

  const { url, digest } = await wslArchive(kind, version, plat);
  const tmpFile = join(tmpdir(), `mcp-wsl-${kind}-${version}-${process.pid}.tar.gz`);
  const dest = wslManagedDir(kind, version);
  const mnt = toWslMntPath(tmpFile);

  try {
    yield* downloadFile({ url, destFile: tmpFile, kind, version, digest });
    yield { kind, phase: 'extract', version };
    // Extract inside the distro: native fs keeps symlinks/exec bits intact.
    // --strip-components=1 drops the archive's single top folder so binaries
    // land at `<dest>/bin` deterministically (matches wslManagedBinDir) —
    // EXCEPT .NET, whose archive is flat (dotnet at the root): stripping would
    // eat real payload dirs, so it extracts as-is into the version dir.
    // For Node, also drop corepack's yarn/pnpm shims into the same bin dir so a
    // `yarn`/`pnpm` script resolves to THIS Node (first on PATH) instead of a
    // Windows package manager leaking in via WSL's PATH interop. Non-fatal.
    const partial = `${dest}.partial-${process.pid}`;
    const corepack =
      kind === 'node'
        ? ` && ( "${partial}/bin/corepack" enable --install-directory "${partial}/bin" >/dev/null 2>&1 || true )`
        : '';
    const strip = kind === 'dotnet' ? '' : ' --strip-components=1';
    const verify = kind === 'java'
      ? `test -x "$partial/bin/java" && test -x "$partial/bin/javac"`
      : kind === 'dotnet'
        ? `test -x "$partial/dotnet" && test -d "$partial/sdk/${version}"`
        : kind === 'node'
          ? `test -x "$partial/bin/node"`
          : `test -x "$partial/bin/python3"`;
    // Extract into a sibling staging directory. The previous SDK survives a
    // corrupt archive; EXIT cleanup removes staging on any tar/corepack/mv
    // failure, and only a complete extraction replaces the destination.
    const script = `set -e; partial="${partial}"; rm -rf "$partial"; mkdir -p "$partial"; trap 'rm -rf "$partial"' EXIT; tar -xzf "${mnt}" -C "$partial"${strip}${corepack}; ${verify}; rm -rf "${dest}"; mv "$partial" "${dest}"; trap - EXIT`;
    await runInDistro(distro, script);
  } finally {
    await rm(tmpFile, { force: true });
  }

  const runtime = (await detectWslRuntimes(kind, distro)).find((r) => r.id === `managed:${version}`);
  if (!runtime) {
    await runInDistro(distro, `rm -rf "${dest}"`);
    throw new Error(`extracted but could not locate ${kind} ${version} in WSL distro "${distro}"`);
  }
  yield { kind, phase: 'done', version, runtime };
}

/** Remove a managed runtime from the distro. */
export async function uninstallWslRuntime(kind: RuntimeKind, version: string, distro: string): Promise<void> {
  assertRuntimeVersion(version);
  await runInDistro(distro, `rm -rf "${wslManagedDir(kind, version)}"`);
}

// ── helpers ──

/** Run a command inside the distro, surfacing a clear error on non-zero exit. */
async function runInDistro(distro: string, script: string): Promise<void> {
  try {
    await execFileAsync('wsl.exe', ['-d', distro, '--', 'bash', '-lc', script], {
      timeout: 180_000,
      maxBuffer: 1 << 20,
      windowsHide: true,
    });
  } catch (e) {
    const err = e as { stderr?: string; message?: string };
    const detail = (err.stderr || err.message || 'unknown error').toString().trim().split(/\r?\n/).pop();
    throw new ApiError('internal', 500, `WSL command failed in "${distro}": ${detail}`);
  }
}

function nodeUrl(version: string, plat: WslPlatform): string {
  const arch = plat.arch === 'aarch64' ? 'arm64' : 'x64';
  return `https://nodejs.org/dist/v${version}/node-v${version}-linux-${arch}.tar.gz`;
}

interface PbsAsset {
  version: string;
  url: string;
}

/**
 * Resolve the python-build-standalone `install_only` asset for a version. Each
 * latest release bundles builds for many Python versions; we pick by exact
 * version + arch + libc.
 */
async function pythonUrl(version: string, plat: WslPlatform): Promise<string> {
  const asset = (await pbsAssets(plat)).find((a) => a.version === version);
  if (!asset) throw new ApiError('not_found', 404, `no python-build-standalone ${version} for ${plat.arch}-${plat.libc}`);
  return asset.url;
}

/** List `install_only` PBS assets for the platform from the latest release. */
async function pbsAssets(plat: WslPlatform): Promise<PbsAsset[]> {
  const res = await fetch(PBS_LATEST, { headers: { 'User-Agent': 'mcp-ide', Accept: 'application/vnd.github+json' } });
  if (!res.ok) throw new ApiError('internal', 500, `python-build-standalone index returned ${res.status}`);
  const rel = (await res.json()) as { assets?: Array<{ name: string; browser_download_url: string }> };
  const suffix = `-${plat.arch}-unknown-linux-${plat.libc}-install_only.tar.gz`;
  const seen = new Set<string>();
  const out: PbsAsset[] = [];
  for (const a of rel.assets ?? []) {
    if (!a.name.endsWith(suffix)) continue;
    const m = /^cpython-(\d+\.\d+\.\d+)\+/.exec(a.name);
    if (!m || seen.has(m[1])) continue;
    seen.add(m[1]);
    out.push({ version: m[1], url: a.browser_download_url });
  }
  // Newest first (semantic-ish: numeric by component).
  out.sort((a, b) => cmpVersionDesc(a.version, b.version));
  return out;
}

function cmpVersionDesc(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pb[i] ?? 0) !== (pa[i] ?? 0)) return (pb[i] ?? 0) - (pa[i] ?? 0);
  }
  return 0;
}
