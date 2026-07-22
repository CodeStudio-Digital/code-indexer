import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { resolveAngularVersion } from '../angular-version-resolver.js';

const roots: string[] = [];

function root(): string {
  const value = mkdtempSync(join(tmpdir(), 'mcp-angular-version-'));
  roots.push(value);
  return value;
}

function write(path: string, value: unknown): void {
  mkdirSync(path.slice(0, Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))), { recursive: true });
  writeFileSync(path, typeof value === 'string' ? value : JSON.stringify(value, null, 2));
}

function packageJson(dir: string, dependencies: Record<string, string>): void {
  write(join(dir, 'package.json'), { dependencies });
}

afterEach(() => {
  for (const value of roots.splice(0)) rmSync(value, { recursive: true, force: true });
});

describe('resolveAngularVersion', () => {
  it('prefers the installed @angular/core package over lock, declaration, and override', () => {
    const projectRoot = root();
    const app = join(projectRoot, 'apps', 'legacy');
    packageJson(app, { '@angular/core': '^12.0.0' });
    write(join(projectRoot, 'package-lock.json'), {
      lockfileVersion: 3,
      packages: { 'apps/legacy/node_modules/@angular/core': { version: '12.2.16' } },
    });
    write(join(app, 'node_modules', '@angular', 'core', 'package.json'), {
      name: '@angular/core', version: '12.2.17',
    });

    const result = resolveAngularVersion({ projectRoot, packageRoot: app, overrideVersion: '11.2.14' });
    expect(result).toMatchObject({
      version: '12.2.17', major: 12, source: 'installed', confidence: 'high', declaredRange: '^12.0.0',
    });
    expect(result.fingerprint).toHaveLength(20);
  });

  it('selects the package-lock entry belonging to a nested package', () => {
    const projectRoot = root();
    const app = join(projectRoot, 'apps', 'admin');
    packageJson(app, { '@angular/core': '^17.0.0' });
    write(join(projectRoot, 'package-lock.json'), {
      lockfileVersion: 3,
      packages: {
        'node_modules/@angular/core': { version: '20.3.2' },
        'apps/admin/node_modules/@angular/core': { version: '17.3.12' },
      },
    });

    expect(resolveAngularVersion({ projectRoot, packageRoot: app })).toMatchObject({
      version: '17.3.12', major: 17, source: 'package-lock', confidence: 'high',
    });
  });

  it('resolves the matching pnpm importer in a mixed-version workspace', () => {
    const projectRoot = root();
    const app = join(projectRoot, 'apps', 'legacy');
    packageJson(app, { '@angular/core': '^14.0.0' });
    write(join(projectRoot, 'pnpm-lock.yaml'), [
      "lockfileVersion: '9.0'",
      'importers:',
      '  .:',
      '    dependencies:',
      "      '@angular/core':",
      '        specifier: ^20.0.0',
      '        version: 20.3.1',
      '  apps/legacy:',
      '    dependencies:',
      "      '@angular/core':",
      '        specifier: ^14.0.0',
      '        version: 14.3.0(@angular/compiler@14.3.0)',
    ].join('\n'));

    expect(resolveAngularVersion({ projectRoot, packageRoot: app })).toMatchObject({
      version: '14.3.0', major: 14, source: 'pnpm-lock',
    });
  });

  it('uses the yarn entry matching the declared major', () => {
    const projectRoot = root();
    packageJson(projectRoot, { '@angular/core': '^13.0.0' });
    write(join(projectRoot, 'yarn.lock'), [
      '"@angular/core@^12.0.0":',
      '  version "12.2.17"',
      '"@angular/core@^13.0.0":',
      '  version "13.4.0"',
    ].join('\n'));

    expect(resolveAngularVersion({ projectRoot, packageRoot: projectRoot })).toMatchObject({
      version: '13.4.0', major: 13, source: 'yarn-lock',
    });
  });

  it('uses a single-major package range before an override without inventing a patch', () => {
    const projectRoot = root();
    packageJson(projectRoot, { '@angular/core': '>=15.0.0 <16.0.0' });

    expect(resolveAngularVersion({
      projectRoot, packageRoot: projectRoot, overrideVersion: '14.3.0',
    })).toMatchObject({
      version: '15.x', major: 15, source: 'package-json', confidence: 'medium',
    });
  });

  it('falls back to an override only for an ambiguous declaration, then to unknown', () => {
    const projectRoot = root();
    packageJson(projectRoot, { '@angular/core': '>=12.0.0' });
    expect(resolveAngularVersion({
      projectRoot, packageRoot: projectRoot, overrideVersion: '12.2.17',
    })).toMatchObject({ version: '12.2.17', major: 12, source: 'override', confidence: 'high' });

    expect(resolveAngularVersion({ projectRoot, packageRoot: projectRoot })).toMatchObject({
      version: null, major: null, source: 'unknown', confidence: 'none',
    });
  });
});

