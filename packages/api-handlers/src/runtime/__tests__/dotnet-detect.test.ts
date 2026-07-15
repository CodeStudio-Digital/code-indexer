/**
 * .NET SDK pure helpers — the platform→rid matrix used to pick the archive
 * from releases.json, and the SDK-folder version ordering (previews sort below
 * their release; we never spawn `dotnet --version`, it honours global.json).
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ridFor } from '../dotnet-manager.js';
import { compareDotnetVersions, detectDotnetRuntimes, newestSdkVersionOf } from '../detect-dotnet.js';

describe('ridFor', () => {
  it.each([
    ['win32', 'x64', 'win-x64'],
    ['win32', 'arm64', 'win-arm64'],
    ['darwin', 'x64', 'osx-x64'],
    ['darwin', 'arm64', 'osx-arm64'],
    ['linux', 'x64', 'linux-x64'],
    ['linux', 'arm64', 'linux-arm64'],
    ['linux', 'ia32', 'linux-x64'], // anything non-arm64 collapses to x64
  ] as const)('%s/%s → %s', (platform, arch, rid) => {
    expect(ridFor(platform as NodeJS.Platform, arch)).toBe(rid);
  });
});

describe('compareDotnetVersions', () => {
  it('orders numerically, not lexically', () => {
    expect(compareDotnetVersions('10.0.100', '9.0.301')).toBeGreaterThan(0);
    expect(compareDotnetVersions('8.0.100', '8.0.204')).toBeLessThan(0);
  });

  it('preview suffix sorts below its release', () => {
    expect(compareDotnetVersions('10.0.100', '10.0.100-preview.7')).toBeGreaterThan(0);
    expect(compareDotnetVersions('10.0.100-preview.7', '10.0.100-preview.6')).toBeGreaterThan(0);
  });
});

describe('newestSdkVersionOf', () => {
  const tmps: string[] = [];
  afterEach(() => {
    for (const dir of tmps.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it('picks the newest sdk folder; empty root → ""', () => {
    const root = mkdtempSync(join(tmpdir(), 'mcp-dotnet-'));
    tmps.push(root);
    expect(newestSdkVersionOf(root)).toBe('');
    for (const v of ['8.0.100', '10.0.100-preview.7', '9.0.301']) {
      mkdirSync(join(root, 'sdk', v), { recursive: true });
    }
    expect(newestSdkVersionOf(root)).toBe('10.0.100-preview.7');
  });

  it('rejects a managed version directory without that exact SDK payload', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'mcp-dotnet-managed-'));
    tmps.push(dataDir);
    const managed = join(dataDir, 'dotnet', '8.0.100');
    mkdirSync(join(managed, 'sdk', '9.0.100'), { recursive: true });
    writeFileSync(join(managed, process.platform === 'win32' ? 'dotnet.exe' : 'dotnet'), '');

    expect(detectDotnetRuntimes(dataDir).filter((runtime) => runtime.source === 'managed')).toEqual([]);

    mkdirSync(join(managed, 'sdk', '8.0.100'), { recursive: true });
    expect(detectDotnetRuntimes(dataDir).filter((runtime) => runtime.source === 'managed'))
      .toEqual([expect.objectContaining({ version: '8.0.100', id: 'managed:8.0.100' })]);
  });
});
