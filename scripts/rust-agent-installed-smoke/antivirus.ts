import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { SignaturePolicy } from './signature.js';

export interface AntivirusReport {
  readonly clean: boolean;
  readonly detail: string;
}

export function scanInstalledRuntime(
  packageDirectory: string,
  _policy: SignaturePolicy,
): AntivirusReport {
  const report = process.platform === 'win32'
    ? scanWithWindowsDefender(packageDirectory)
    : process.platform === 'linux'
      ? scanWithClamAv(packageDirectory)
      : {
        clean: false,
        detail: 'no scriptable macOS antivirus scanner is configured',
      };
  return Object.freeze(report);
}

function scanWithWindowsDefender(packageDirectory: string): AntivirusReport {
  const executable = windowsDefenderCli();
  if (!executable) {
    return { clean: false, detail: 'Microsoft Defender CLI was not found' };
  }
  const result = spawnSync(executable, [
    '-Scan',
    '-ScanType',
    '3',
    '-File',
    packageDirectory,
    '-DisableRemediation',
  ], {
    encoding: 'utf8',
    shell: false,
    timeout: 120_000,
    windowsHide: true,
  });
  if (result.status === 0) {
    return { clean: true, detail: 'Microsoft Defender found no threat' };
  }
  return {
    clean: false,
    detail: commandFailure(result, 'Microsoft Defender scan failed'),
  };
}

function windowsDefenderCli(): string | undefined {
  const platformRoot = join(
    process.env.ProgramData ?? 'C:\\ProgramData',
    'Microsoft',
    'Windows Defender',
    'Platform',
  );
  if (existsSync(platformRoot)) {
    const versions = readdirSync(platformRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort((left, right) => right.localeCompare(left, undefined, {
        numeric: true,
      }));
    const current = versions
      .map((version) => join(platformRoot, version, 'MpCmdRun.exe'))
      .find(existsSync);
    if (current) return current;
  }
  const fallback = join(
    process.env.ProgramFiles ?? 'C:\\Program Files',
    'Windows Defender',
    'MpCmdRun.exe',
  );
  return existsSync(fallback) ? fallback : undefined;
}

function scanWithClamAv(packageDirectory: string): AntivirusReport {
  const result = spawnSync(
    'clamscan',
    ['--recursive', '--infected', '--no-summary', packageDirectory],
    { encoding: 'utf8', shell: false, timeout: 120_000 },
  );
  if (!result.error && result.status === 0) {
    return { clean: true, detail: 'ClamAV found no threat' };
  }
  return {
    clean: false,
    detail: commandFailure(result, 'ClamAV is unavailable or rejected package'),
  };
}

function commandFailure(
  result: ReturnType<typeof spawnSync>,
  fallback: string,
): string {
  const output = `${result.stderr ?? ''}\n${result.stdout ?? ''}`
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .find(Boolean);
  return (output || result.error?.message || fallback).slice(0, 240);
}
