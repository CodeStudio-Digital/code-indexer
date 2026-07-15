/**
 * .NET SDK runtime manager — official Microsoft builds via the release
 * metadata index. Portable archives on every OS (zip on Windows, tar.gz on
 * mac/linux) extracted under <dataDir>/dotnet/<version>/. SDK archives are
 * FLAT (dotnet(.exe) + sdk/ + shared/ at the root), so the version dir is the
 * dotnet root itself — DOTNET_ROOT points straight at it.
 */

import { existsSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { ApiError } from '@mcp/api-bus';
import type { InstallProgress, RuntimeRelease } from '@mcp/api-bus';
import { detectDotnetRuntimes } from './detect-dotnet.js';
import { downloadAndExtract, managedRuntimeRoot } from './runtime-shared.js';
import { assertRuntimeVersion, managedVersionFromId } from './runtime-version.js';

const INDEX_URL = 'https://builds.dotnet.microsoft.com/dotnet/release-metadata/releases-index.json';
const PHASES = new Set(['active', 'maintenance', 'preview', 'go-live']);

/** Runtime identifier for the current platform, e.g. 'win-x64' / 'osx-arm64'. */
export function ridFor(platform: NodeJS.Platform = process.platform, arch: string = process.arch): string {
  const os = platform === 'win32' ? 'win' : platform === 'darwin' ? 'osx' : 'linux';
  return `${os}-${arch === 'arm64' ? 'arm64' : 'x64'}`;
}

interface Channel {
  'channel-version'?: string;
  'latest-sdk'?: string;
  'support-phase'?: string;
  'release-type'?: string;
  'releases.json'?: string;
}

interface SdkFile { name?: string; rid?: string; url?: string; hash?: string }
interface SdkEntry { version?: string; files?: SdkFile[] }
interface ChannelRelease { sdk?: SdkEntry; sdks?: SdkEntry[] }

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`dotnet release metadata returned ${res.status} for ${url}`);
  return (await res.json()) as T;
}

async function fetchChannels(): Promise<Channel[]> {
  const data = await fetchJson<{ 'releases-index'?: Channel[] }>(INDEX_URL);
  return (data['releases-index'] ?? []).filter((c) => PHASES.has(c['support-phase'] ?? ''));
}

/** Latest SDK per supported channel, newest channel first. */
export async function listReleases(): Promise<RuntimeRelease[]> {
  const channels = await fetchChannels();
  const out: RuntimeRelease[] = [];
  for (const c of channels) {
    if (!c['latest-sdk'] || !c['channel-version']) continue;
    const lts = c['release-type'] === 'lts' ? ' (LTS)' : '';
    const preview = c['support-phase'] === 'preview' || c['support-phase'] === 'go-live' ? ' (preview)' : '';
    out.push({ version: c['latest-sdk'], label: `.NET SDK ${c['channel-version']}${lts}${preview}` });
  }
  return out.sort((a, b) => b.version.localeCompare(a.version, undefined, { numeric: true }));
}

/** Archive URL for an exact SDK version on a platform (default: this one). */
export async function sdkArchiveUrl(
  version: string,
  rid = ridFor(),
): Promise<{ url: string; ext: 'zip' | 'tar.gz'; sha512: string }> {
  assertRuntimeVersion(version);
  const channels = await fetchChannels();
  const channel =
    channels.find((c) => c['latest-sdk'] === version) ??
    channels.find((c) => c['channel-version'] && version.startsWith(`${c['channel-version']}.`));
  const releasesUrl = channel?.['releases.json'];
  if (!releasesUrl) throw new ApiError('not_found', 404, `no .NET channel found for SDK ${version}`);

  const data = await fetchJson<{ releases?: ChannelRelease[] }>(releasesUrl);
  for (const release of data.releases ?? []) {
    const entries = [release.sdk, ...(release.sdks ?? [])];
    for (const sdk of entries) {
      if (sdk?.version !== version) continue;
      const file = (sdk.files ?? []).find(
        (f) => f.rid === rid && f.url && (f.name?.endsWith('.zip') || f.name?.endsWith('.tar.gz')),
      );
      if (file?.url && file.hash) {
        return { url: file.url, ext: file.name!.endsWith('.zip') ? 'zip' : 'tar.gz', sha512: file.hash };
      }
    }
  }
  throw new ApiError('not_found', 404, `no .NET SDK ${version} archive for ${rid}`);
}

export async function* install(version: string, managedDir: string): AsyncGenerator<InstallProgress> {
  assertRuntimeVersion(version);
  const { url, ext, sha512 } = await sdkArchiveUrl(version);
  const destDir = join(managedRuntimeRoot(managedDir, 'dotnet'), version);
  yield* downloadAndExtract({
    url,
    ext,
    destDir,
    kind: 'dotnet',
    version,
    digest: { algorithm: 'sha512', expected: sha512 },
    validateExtracted: (stagedDir) => existsSync(join(stagedDir, process.platform === 'win32' ? 'dotnet.exe' : 'dotnet'))
      && existsSync(join(stagedDir, 'sdk', version)),
  });

  const runtime = detectDotnetRuntimes(managedDir).find((r) => r.id === `managed:${version}`);
  if (!runtime) {
    await rm(destDir, { recursive: true, force: true });
    throw new Error(`extracted but could not locate dotnet under ${destDir}`);
  }
  yield { kind: 'dotnet', phase: 'done', version, runtime };
}

export async function uninstall(version: string, managedDir: string): Promise<void> {
  assertRuntimeVersion(version);
  await rm(join(managedRuntimeRoot(managedDir, 'dotnet'), version), { recursive: true, force: true });
}

/** Dotnet root dir (= bin dir) for a chosen dotnet id, or null for system default. */
export function resolveDotnetRoot(id: string | null | undefined, managedDir: string): string | null {
  if (!id || id === 'system') return null;
  managedVersionFromId(id);
  return detectDotnetRuntimes(managedDir).find((r) => r.id === id)?.binDir ?? null;
}
