/**
 * External / PECL PHP extension install.
 *
 * Windows (managed install): fetch a prebuilt DLL from windows.php.net,
 * matching the install's ABI (PHP minor + thread-safety + VC/VS token + arch,
 * all read from `php -i` so we never guess), drop it in ext/, enable it.
 *
 * macOS/Linux: shell out to `pecl install <ext>` (compiles; needs pecl +
 * build tools). Touches the shared PHP, so the UI gates this behind confirm.
 */

import { copyFileSync, existsSync, mkdtempSync, readdirSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { extractZipToDir } from '@mcp/shared/utils/extract-zip.js';
import type { InstallProgress } from '@mcp/api-bus';
import { isWin, probe } from './detect-shared.js';
import { downloadFile } from './runtime-shared.js';
import { phpExtDir, setExtension } from './php-extensions.js';
import { spawnLogStream } from './installers/shell-stream.js';

const PECL_BASE = 'https://windows.php.net/downloads/pecl/releases/';
const PHP_EXE = isWin ? 'php.exe' : 'php';

interface PhpAbi {
  minor: string;
  ts: 'nts' | 'ts';
  vc: string; // e.g. 'vs16' / 'vc15'
  arch: 'x64' | 'x86' | 'arm64';
}

/** Read ABI tokens from `php -i` (authoritative — no guessing the VC token). */
function readAbi(phpBinDir: string): PhpAbi | null {
  const info = probe(join(phpBinDir, PHP_EXE), ['-i']);
  if (!info) return null;
  const minor = /PHP Version => (\d+\.\d+)/.exec(info)?.[1] ?? '';
  const build = /PHP Extension Build => API\d+,(NTS|TS),(VC|VS)(\d+)/i.exec(info);
  const arch = (/Architecture => (x64|x86|arm64)/i.exec(info)?.[1] ?? 'x64').toLowerCase() as PhpAbi['arch'];
  if (!minor || !build) return null;
  return {
    minor,
    ts: build[1].toLowerCase() as 'nts' | 'ts',
    vc: `${build[2]}${build[3]}`.toLowerCase(),
    arch,
  };
}

/** Latest stable version folder for an extension on windows.php.net. */
async function latestPeclVersion(name: string): Promise<string | null> {
  const res = await fetch(`${PECL_BASE}${name}/`);
  if (!res.ok) return null;
  const html = await res.text();
  const versions = [...html.matchAll(/href="(\d+\.\d+\.\d+)\/"/g)].map((m) => m[1]);
  const stable = versions.filter((v) => /^\d+\.\d+\.\d+$/.test(v));
  return stable.sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))[0] ?? null;
}

/** Find the DLL zip matching our ABI within an extension's version folder. */
async function matchDllZip(name: string, extVer: string, abi: PhpAbi): Promise<string | null> {
  const res = await fetch(`${PECL_BASE}${name}/${extVer}/`);
  if (!res.ok) return null;
  const html = await res.text();
  const wanted = new RegExp(
    `php_${name}-${extVer}-${abi.minor}-${abi.ts}-${abi.vc}-${abi.arch}\\.zip`,
    'i',
  );
  return [...html.matchAll(/href="([^"]+\.zip)"/g)].map((m) => m[1]).find((f) => wanted.test(f)) ?? null;
}

export async function* installPeclExtension(opts: {
  version: string;
  name: string;
  installDir: string | null; // managed install dir (Windows); null = system/brew
  phpBinDir: string;
}): AsyncGenerator<InstallProgress> {
  const { version, name, installDir, phpBinDir } = opts;

  // Hard allowlist — extension names are `[a-z0-9_]+`. Rejecting anything else
  // up front both prevents a shell-injection sink (the unix path) and avoids
  // building bogus URLs / file checks (the Windows path).
  if (!/^[a-z0-9_]+$/.test(name)) {
    throw new Error(`invalid PHP extension name "${name}" (expected [a-z0-9_]+)`);
  }

  if (!isWin || !installDir) {
    // Shell-out path — compiles into the shared PHP. No shell: pecl is an
    // executable on PATH, so spawn resolves it directly (argv stays intact).
    yield { kind: 'php', phase: 'install', version, line: `pecl install ${name}` };
    for await (const line of spawnLogStream('pecl', ['install', name])) {
      yield { kind: 'php', phase: 'log', version, line };
    }
    yield { kind: 'php', phase: 'done', version };
    return;
  }

  const abi = readAbi(phpBinDir);
  if (!abi) throw new Error('could not read PHP ABI (php -i) — is the managed PHP intact?');

  const extVer = await latestPeclVersion(name);
  if (!extVer) throw new Error(`no Windows PECL release found for "${name}"`);
  const file = await matchDllZip(name, extVer, abi);
  if (!file) {
    throw new Error(
      `no "${name}" ${extVer} DLL for PHP ${abi.minor} ${abi.ts}/${abi.vc}/${abi.arch} — incompatible build`,
    );
  }

  const url = file.startsWith('http') ? file : `${PECL_BASE}${name}/${extVer}/${file.replace(/^.*\//, '')}`;
  const tmpFile = join(tmpdir(), `mcp-pecl-${name}-${process.pid}.zip`);
  const tmpDir = mkdtempSync(join(tmpdir(), `mcp-pecl-${name}-`));
  try {
    yield* downloadFile({ url, destFile: tmpFile, kind: 'php', version });
    yield { kind: 'php', phase: 'extract', version };
    extractZipToDir(tmpFile, tmpDir, { clean: true });
    // Copy every DLL the package ships (the extension + any bundled deps).
    const ext = phpExtDir(installDir);
    for (const f of readdirSync(tmpDir)) {
      if (/\.dll$/i.test(f)) copyFileSync(join(tmpDir, f), join(ext, f));
    }
    if (!existsSync(join(ext, `php_${name}.dll`))) {
      throw new Error(`downloaded package did not contain php_${name}.dll`);
    }
    setExtension(installDir, name, true);
  } finally {
    await rm(tmpFile, { force: true });
    await rm(tmpDir, { recursive: true, force: true });
  }

  yield { kind: 'php', phase: 'done', version };
}
