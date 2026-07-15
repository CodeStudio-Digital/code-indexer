/**
 * Java (JDK) runtime manager — official Eclipse Temurin builds via the
 * Adoptium v3 API. Portable archives on every OS (zip on Windows, tar.gz on
 * mac/linux) extracted under <dataDir>/java/<version>/ — no brew/choco needed.
 * The archive nests a top-level folder (and Contents/Home on macOS); the
 * detector's javaHomeOf() resolves it, so we extract as-is.
 */

import { existsSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { ApiError } from '@mcp/api-bus';
import type { InstallProgress, Runtime, RuntimeRelease } from '@mcp/api-bus';
import { detectJavaRuntimes, javaHomeOf } from './detect-java.js';
import { downloadAndExtract, managedRuntimeRoot } from './runtime-shared.js';
import { isWin, normalizeSemver } from './detect-shared.js';
import { assertRuntimeVersion, managedVersionFromId } from './runtime-version.js';

const API = 'https://api.adoptium.net/v3';

export function osToken(platform: NodeJS.Platform = process.platform): 'windows' | 'mac' | 'linux' {
  if (platform === 'win32') return 'windows';
  return platform === 'darwin' ? 'mac' : 'linux';
}

export function archToken(arch: string = process.arch): 'x64' | 'aarch64' {
  return arch === 'arm64' ? 'aarch64' : 'x64';
}

interface AvailableReleases {
  available_lts_releases?: number[];
  most_recent_feature_release?: number;
  most_recent_lts?: number;
}

interface AdoptiumAsset {
  version?: { semver?: string };
  binary?: { package?: { link?: string; name?: string; checksum?: string } };
}

export interface JdkArchive { url: string; version: string; sha256: string }

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`adoptium.net returned ${res.status} for ${url}`);
  return (await res.json()) as T;
}

/** Latest Temurin JDK asset for a feature version on this platform, or null. */
async function latestAsset(
  feature: number,
  os = osToken(),
  arch = archToken(),
): Promise<JdkArchive | null> {
  try {
    const assets = await fetchJson<AdoptiumAsset[]>(
      `${API}/assets/latest/${feature}/hotspot?os=${os}&architecture=${arch}&image_type=jdk&vendor=eclipse`,
    );
    const a = assets.find((x) => x.binary?.package?.link && x.binary.package.checksum && x.version?.semver);
    if (!a) return null;
    return {
      url: a.binary!.package!.link!,
      version: normalizeSemver(a.version!.semver!),
      sha256: a.binary!.package!.checksum!,
    };
  } catch {
    return null;
  }
}

/** LTS lines + the most recent feature release, newest first. */
export async function listReleases(os = osToken(), arch = archToken()): Promise<RuntimeRelease[]> {
  const info = await fetchJson<AvailableReleases>(`${API}/info/available_releases`);
  const lts = new Set(info.available_lts_releases ?? []);
  const majors = [...new Set([...lts, ...(info.most_recent_feature_release ? [info.most_recent_feature_release] : [])])]
    .sort((a, b) => b - a);

  const results = await Promise.allSettled(majors.map(async (major) => {
    const asset = await latestAsset(major, os, arch);
    if (!asset) return null;
    const release: RuntimeRelease = {
      version: asset.version,
      label: `Temurin ${major}${lts.has(major) ? ' (LTS)' : ''}`,
    };
    return release;
  }));
  return results
    .map((r) => (r.status === 'fulfilled' ? r.value : null))
    .filter((r): r is RuntimeRelease => r !== null);
}

/** Archive URL for an exact version (as offered by listReleases) on os/arch. */
export async function assetUrlFor(version: string, os = osToken(), arch = archToken()): Promise<string> {
  return (await archiveFor(version, os, arch)).url;
}

/** Archive URL + official SHA-256 for an exact version. */
export async function archiveFor(version: string, os = osToken(), arch = archToken()): Promise<JdkArchive> {
  assertRuntimeVersion(version);
  const major = Number.parseInt(version, 10);
  if (!Number.isFinite(major)) throw new ApiError('invalid', 400, `invalid JDK version: ${version}`);
  const asset = await latestAsset(major, os, arch);
  if (!asset) throw new ApiError('not_found', 404, `no Temurin ${major} build for ${os}/${arch}`);
  if (asset.version !== version) {
    throw new ApiError('conflict', 409, `Temurin ${major} moved to ${asset.version} — refresh the release list`);
  }
  return asset;
}

export async function* install(version: string, managedDir: string): AsyncGenerator<InstallProgress> {
  assertRuntimeVersion(version);
  const asset = await archiveFor(version);
  const destDir = join(managedRuntimeRoot(managedDir, 'java'), version);
  yield* downloadAndExtract({
    url: asset.url,
    ext: isWin ? 'zip' : 'tar.gz',
    destDir,
    kind: 'java',
    version,
    digest: { algorithm: 'sha256', expected: asset.sha256 },
    validateExtracted: (stagedDir) => {
      const home = javaHomeOf(stagedDir);
      return !!home && existsSync(join(home, 'bin', isWin ? 'javac.exe' : 'javac'));
    },
  });

  const runtime = detectJavaRuntimes(managedDir).find((r) => r.id === `managed:${version}`);
  if (!runtime) {
    await rm(destDir, { recursive: true, force: true });
    throw new Error(`extracted but could not locate a JDK under ${destDir}`);
  }
  yield { kind: 'java', phase: 'done', version, runtime };
}

export async function uninstall(version: string, managedDir: string): Promise<void> {
  assertRuntimeVersion(version);
  await rm(join(managedRuntimeRoot(managedDir, 'java'), version), { recursive: true, force: true });
}

/** Bin dir + JAVA_HOME for a chosen java id, or null for system default. */
export function resolveJavaEnv(
  id: string | null | undefined,
  managedDir: string,
): { binDir: string; home: string } | null {
  if (!id || id === 'system') return null;
  const managedVersion = managedVersionFromId(id);
  if (managedVersion) {
    // Fast path: derive from the managed folder without a full detect sweep.
    const home = javaHomeOf(join(managedRuntimeRoot(managedDir, 'java'), managedVersion));
    return home ? { binDir: join(home, 'bin'), home } : null;
  }
  const match = detectJavaRuntimes(managedDir).find((r) => r.id === id);
  return match ? { binDir: match.binDir, home: dirname(match.binDir) } : null;
}
