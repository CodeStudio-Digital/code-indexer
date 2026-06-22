/**
 * Windows PHP install — portable zip from windows.php.net. No dependency on
 * any package manager: download the NTS x64 build, extract into the managed
 * dir, seed php.ini (extension_dir → ext/, enable a sane default set).
 *
 * `releases.json` lists the CURRENT patch per version line; that's what we
 * offer and install. (Older patches would need the archives folder + exact
 * VC token; out of scope for v1.)
 */

import { join } from 'node:path';
import type { InstallProgress, RuntimeRelease } from '@mcp/api-bus';
import { managedRuntimeRoot, downloadAndExtract } from '../runtime-shared.js';
import { detectPhpRuntimes } from '../detect-php.js';
import { seedManagedIni } from '../php-extensions.js';

const RELEASES_URL = 'https://windows.php.net/downloads/releases/releases.json';
const BASE_URL = 'https://windows.php.net/downloads/releases/';

/** Composer + everyday-CLI friendly defaults (all ship in the Windows build). */
const DEFAULT_EXTENSIONS = ['openssl', 'curl', 'mbstring', 'fileinfo', 'zip', 'pdo_sqlite', 'pdo_mysql', 'gd', 'intl'];

interface ZipInfo {
  zip?: { path?: string };
}
type ReleaseEntry = { version?: string } & Record<string, ZipInfo | unknown>;

/** Pick the NTS x64 zip path for a release entry (fallback: any nts-x64, then ts-x64). */
function ntsX64Zip(entry: ReleaseEntry): string | null {
  const keys = Object.keys(entry);
  const pref =
    keys.find((k) => /^nts-vs\d+-x64$/i.test(k)) ??
    keys.find((k) => /^nts-.*-x64$/i.test(k)) ??
    keys.find((k) => /^ts-.*-x64$/i.test(k));
  const path = pref ? (entry[pref] as ZipInfo)?.zip?.path : undefined;
  return path ?? null;
}

async function fetchReleases(): Promise<Record<string, ReleaseEntry>> {
  const res = await fetch(RELEASES_URL);
  if (!res.ok) throw new Error(`windows.php.net returned ${res.status}`);
  return (await res.json()) as Record<string, ReleaseEntry>;
}

export async function listReleases(): Promise<RuntimeRelease[]> {
  const data = await fetchReleases();
  const out: RuntimeRelease[] = [];
  for (const [minor, entry] of Object.entries(data)) {
    if (entry?.version && ntsX64Zip(entry)) {
      out.push({ version: entry.version, label: `PHP ${minor}` });
    }
  }
  return out.sort((a, b) => b.version.localeCompare(a.version, undefined, { numeric: true }));
}

export async function* install(version: string, managedDir: string): AsyncGenerator<InstallProgress> {
  const data = await fetchReleases();
  const entry = Object.values(data).find((e) => e?.version === version);
  const path = entry ? ntsX64Zip(entry) : null;
  if (!path) throw new Error(`no Windows NTS x64 build for PHP ${version}`);

  const destDir = join(managedRuntimeRoot(managedDir, 'php'), version);
  yield* downloadAndExtract({ url: BASE_URL + path, ext: 'zip', destDir, kind: 'php', version });

  yield { kind: 'php', phase: 'install', version, line: 'Seeding php.ini…' };
  seedManagedIni(destDir, DEFAULT_EXTENSIONS);

  const runtime = detectPhpRuntimes(managedDir).find((r) => r.id === `managed:${version}`);
  if (!runtime) throw new Error(`extracted but could not locate php under ${destDir}`);
  yield { kind: 'php', phase: 'done', version, runtime };
}
