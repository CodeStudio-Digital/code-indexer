import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { invalidateProjectDiscoveryCache } from '@mcp/shared/utils/project-ignore.js';
import { clearComposerProjectScanCache } from '../composer-project-files.js';
import { detectRunners, detectRunnersAsync } from '../detect.js';

let root: string;

function writeComposer(relativeDir: string, scripts: Record<string, string>): void {
  const dir = join(root, relativeDir);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'composer.json'), JSON.stringify({ scripts }));
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'detect-php-'));
});

afterEach(() => {
  clearComposerProjectScanCache();
  invalidateProjectDiscoveryCache(root);
  rmSync(root, { recursive: true, force: true });
});

describe('detectPhp', () => {
  it('keeps live scripts in a Unity backend and skips generated and dependency manifests', async () => {
    mkdirSync(join(root, 'Assets'));
    mkdirSync(join(root, 'ProjectSettings'));
    writeFileSync(join(root, 'ProjectSettings/ProjectVersion.txt'), 'm_EditorVersion: 6000');
    writeComposer('backend', { first: 'echo ok' });
    writeComposer('Library/PackageCache/pkg', { generated: 'echo skip' });
    writeComposer('backend/vendor/vendor/package', { dependency: 'echo skip' });
    const scripts = async () => (await detectRunnersAsync(root)).groups.flatMap(group => group.runners.map(runner => runner.label));
    expect(await scripts()).toEqual(['first']);
    writeComposer('backend', { second: 'echo changed' });
    expect(await scripts()).toEqual(['second']);
  });
  it('keeps root composer runner compatibility', () => {
    writeComposer('', { setup: 'php index.php' });
    const group = detectRunners(root, { shellFamily: 'powershell' }).groups.find((item) => item.manager === 'composer');

    expect(group).toMatchObject({
      source: 'composer.json',
      cwd: undefined,
      installNeeded: true,
    });
    expect(group?.runners[0]).toMatchObject({
      id: 'composer:setup',
      command: "composer run 'setup'",
    });
  });

  it('detects a nested composer project and assigns its working directory', async () => {
    writeComposer('infrastructure', { 'setup-db': 'php ../index.php --database setup' });

    const group = (await detectRunnersAsync(root, { shellFamily: 'powershell' }))
      .groups.find((item) => item.manager === 'composer');

    expect(group).toMatchObject({
      source: 'infrastructure/composer.json',
      cwd: 'infrastructure',
      installNeeded: true,
    });
    expect(group?.runners[0]).toMatchObject({
      id: 'composer:infrastructure:setup-db',
      command: "composer run 'setup-db'",
    });
  });

  it('keeps same-named scripts from separate composer projects distinct', () => {
    writeComposer('apps/api', { setup: 'php index.php' });
    writeComposer('infrastructure', { setup: 'php index.php' });

    const groups = detectRunners(root, { shellFamily: 'powershell' }).groups
      .filter((item) => item.manager === 'composer');

    expect(groups.map((group) => group.source)).toEqual([
      'apps/api/composer.json',
      'infrastructure/composer.json',
    ]);
    expect(groups.map((group) => group.runners[0]?.id)).toEqual([
      'composer:apps/api:setup',
      'composer:infrastructure:setup',
    ]);
  });

  it('does not surface dependency-owned composer manifests', () => {
    writeComposer('infrastructure', { setup: 'php index.php' });
    writeComposer('infrastructure/vendor/acme/package', { test: 'phpunit' });
    writeComposer('node_modules/tool', { test: 'phpunit' });

    const groups = detectRunners(root).groups.filter((item) => item.manager === 'composer');

    expect(groups.map((group) => group.source)).toEqual(['infrastructure/composer.json']);
  });

  it('checks vendor beside the nested manifest', () => {
    writeComposer('infrastructure', { setup: 'php index.php' });
    mkdirSync(join(root, 'infrastructure', 'vendor'));

    const group = detectRunners(root).groups.find((item) => item.manager === 'composer');

    expect(group?.installNeeded).toBe(false);
  });
});
