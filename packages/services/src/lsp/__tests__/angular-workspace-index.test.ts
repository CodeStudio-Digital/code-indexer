import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  getAngularWorkspaceIndex,
  buildAngularWorkspaceIndex,
  loadAngularWorkspaceIndex,
  invalidateAngularWorkspaceForPath,
  invalidateAngularWorkspaceIndex,
  resolveAngularWorkspace,
} from '../angular-workspace-index.js';

const roots: string[] = [];

function root(): string {
  const value = mkdtempSync(join(tmpdir(), 'mcp-angular-workspace-'));
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

function touch(path: string): void {
  write(path, '');
}

afterEach(() => {
  invalidateAngularWorkspaceIndex();
  for (const value of roots.splice(0)) rmSync(value, { recursive: true, force: true });
});

describe('Angular workspace index', () => {
  it('shares a background scan and starts its TTL after the worker completes', async () => {
    const projectRoot = root();
    let now = 0;
    let calls = 0;
    const options = { now: () => now, ttlMs: 30 };
    const scan = async () => {
      calls++;
      await Promise.resolve();
      now += 50;
      return buildAngularWorkspaceIndex(projectRoot, options, now);
    };
    const first = loadAngularWorkspaceIndex(projectRoot, options, scan);
    const second = loadAngularWorkspaceIndex(projectRoot, options, scan);
    expect(await first).toBe(await second);
    now += 29;
    expect(await loadAngularWorkspaceIndex(projectRoot, options, scan)).toBe(await first);
    expect(calls).toBe(1);
    now += 1;
    expect(await loadAngularWorkspaceIndex(projectRoot, options, scan)).not.toBe(await first);
    expect(calls).toBe(2);
  });

  it('discards in-flight metadata after invalidation and retries failed discovery', async () => {
    const projectRoot = root();
    const old = buildAngularWorkspaceIndex(projectRoot, {}, 0);
    let release!: (value: typeof old) => void;
    const first = loadAngularWorkspaceIndex(projectRoot, {}, () => new Promise(resolve => { release = resolve; }));
    invalidateAngularWorkspaceIndex(projectRoot);
    await expect(loadAngularWorkspaceIndex(projectRoot, {}, async () => { throw new Error('scan failed'); })).rejects.toThrow('scan failed');
    packageJson(projectRoot, { '@angular/core': '19.0.0' });
    const fresh = await loadAngularWorkspaceIndex(projectRoot, {}, async () => buildAngularWorkspaceIndex(projectRoot, {}, 1));
    release(old);
    expect(await first).toBe(fresh);
    expect(fresh.facets[0]?.major).toBe(19);
  });

  it('maps Angular CLI multi-project files by the longest source-root prefix', () => {
    const projectRoot = root();
    packageJson(projectRoot, { '@angular/core': '^17.0.0' });
    write(join(projectRoot, 'angular.json'), {
      version: 1,
      projects: {
        admin: { root: 'apps/admin', sourceRoot: 'apps/admin/src' },
        portal: { root: 'apps/portal', sourceRoot: 'apps/portal/client' },
      },
    });
    touch(join(projectRoot, 'apps', 'admin', 'src', 'app', 'app.component.ts'));
    touch(join(projectRoot, 'apps', 'portal', 'client', 'app.component.html'));

    const admin = resolveAngularWorkspace(projectRoot, 'apps/admin/src/app/app.component.ts');
    const portal = resolveAngularWorkspace(projectRoot, 'apps/portal/client/app.component.html');
    expect(admin).toMatchObject({ name: 'admin', version: '17.x', major: 17, versionSource: 'package-json' });
    expect(portal).toMatchObject({ name: 'portal', version: '17.x', major: 17, versionSource: 'package-json' });
    expect(admin?.sourceRoots[0]).toMatch(/apps\/admin\/src$/);
    expect(portal?.sourceRoots[0]).toMatch(/apps\/portal\/client$/);
    expect(admin?.workspaceRoot).toBe(portal?.workspaceRoot);
  });

  it('keeps nested Angular package roots and versions isolated in one repository', () => {
    const projectRoot = root();
    const legacy = join(projectRoot, 'apps', 'legacy');
    const modern = join(projectRoot, 'apps', 'modern');
    for (const [dir, version] of [[legacy, '12.2.17'], [modern, '20.3.2']] as const) {
      packageJson(dir, { '@angular/core': `^${version}` });
      write(join(dir, 'angular.json'), { version: 1, projects: { app: { root: '', sourceRoot: 'src' } } });
      write(join(dir, 'node_modules', '@angular', 'core', 'package.json'), { name: '@angular/core', version });
      touch(join(dir, 'src', 'app.component.ts'));
    }

    const oldRoute = resolveAngularWorkspace(projectRoot, 'apps/legacy/src/app.component.ts');
    const newRoute = resolveAngularWorkspace(projectRoot, 'apps/modern/src/app.component.ts');
    expect(oldRoute).toMatchObject({ version: '12.2.17', major: 12, versionSource: 'installed' });
    expect(newRoute).toMatchObject({ version: '20.3.2', major: 20, versionSource: 'installed' });
    expect(oldRoute?.packageRoot).not.toBe(newRoute?.packageRoot);
    expect(oldRoute?.fingerprint).not.toBe(newRoute?.fingerprint);
  });

  it('keys overrides by package root without leaking the root override into a nested facet', () => {
    const projectRoot = root();
    const legacy = join(projectRoot, 'apps', 'legacy');
    packageJson(legacy, { '@angular/core': 'workspace:*' });
    write(join(projectRoot, 'angular.json'), {
      projects: { legacy: { root: 'apps/legacy', sourceRoot: 'apps/legacy/src' } },
    });
    touch(join(legacy, 'src', 'app.component.ts'));

    const rootOnly = resolveAngularWorkspace(
      projectRoot,
      'apps/legacy/src/app.component.ts',
      { overrides: { '.': '12.x' } },
    );
    expect(rootOnly).toMatchObject({
      overridePath: 'apps/legacy',
      major: null,
      versionSource: 'unknown',
    });
    expect(rootOnly?.workspaceRoot).toBe(getAngularWorkspaceIndex(projectRoot, {
      overrides: { '.': '12.x' },
    }).projectRoot);

    expect(resolveAngularWorkspace(
      projectRoot,
      'apps/legacy/src/app.component.ts',
      { overrides: { 'apps/legacy': '12.x' } },
    )).toMatchObject({ overridePath: 'apps/legacy', major: 12, versionSource: 'override' });
  });

  it('recognizes a basic Nx Angular project and anchors it at the Nx workspace', () => {
    const projectRoot = root();
    packageJson(projectRoot, { '@angular/core': '~16.2.0', '@nx/angular': '^16.0.0' });
    write(join(projectRoot, 'nx.json'), { targetDefaults: {} });
    write(join(projectRoot, 'apps', 'admin', 'project.json'), {
      name: 'admin',
      root: 'apps/admin',
      sourceRoot: 'apps/admin/src',
      targets: { build: { executor: '@nx/angular:webpack-browser' } },
    });
    touch(join(projectRoot, 'apps', 'admin', 'src', 'main.ts'));

    const route = resolveAngularWorkspace(projectRoot, 'apps/admin/src/main.ts');
    expect(route).toMatchObject({ name: 'admin', version: '16.x', major: 16 });
    expect(route?.workspaceRoot).toMatch(/mcp-angular-workspace-[^/]+$/);
    expect(route?.sourceRoots[0]).toMatch(/apps\/admin\/src$/);
  });

  it('lets a more specific nested workspace win over a broad parent source root', () => {
    const projectRoot = root();
    packageJson(projectRoot, { '@angular/core': '^17.0.0' });
    write(join(projectRoot, 'angular.json'), {
      projects: { shell: { root: 'apps', sourceRoot: 'apps' } },
    });
    const nested = join(projectRoot, 'apps', 'admin');
    packageJson(nested, { '@angular/core': '^12.0.0' });
    write(join(nested, 'angular.json'), { projects: { admin: { root: '', sourceRoot: 'src' } } });
    touch(join(nested, 'src', 'app.component.html'));

    const route = resolveAngularWorkspace(projectRoot, 'apps/admin/src/app.component.html');
    expect(route).toMatchObject({ name: 'admin', major: 12, version: '12.x' });
    expect(route?.packageRoot).toMatch(/apps\/admin$/);
  });

  it('does not mistake AngularJS or blocked dependency trees for Angular workspaces', () => {
    const projectRoot = root();
    packageJson(projectRoot, { angular: '1.8.3' });
    packageJson(join(projectRoot, 'node_modules', 'hidden-app'), { '@angular/core': '^20.0.0' });
    write(join(projectRoot, 'node_modules', 'hidden-app', 'angular.json'), {});

    expect(getAngularWorkspaceIndex(projectRoot).facets).toEqual([]);
    expect(resolveAngularWorkspace(projectRoot, 'src/app.js')).toBeNull();
  });

  it('caches negative scans and refreshes only after relevant invalidation', () => {
    const projectRoot = root();
    const first = getAngularWorkspaceIndex(projectRoot);
    packageJson(projectRoot, { '@angular/core': '^19.0.0' });
    write(join(projectRoot, 'angular.json'), {});
    touch(join(projectRoot, 'src', 'main.ts'));

    expect(getAngularWorkspaceIndex(projectRoot)).toBe(first);
    expect(resolveAngularWorkspace(projectRoot, 'src/main.ts')).toBeNull();
    expect(invalidateAngularWorkspaceForPath(projectRoot, 'src/main.ts')).toBe(false);
    expect(invalidateAngularWorkspaceForPath(projectRoot, 'package.json')).toBe(true);
    expect(resolveAngularWorkspace(projectRoot, 'src/main.ts')).toMatchObject({ major: 19 });
  });

  it('notifies metadata subscribers only for watcher-relevant Angular files', async () => {
    const projectRoot = root();
    const events: Array<{ projectRoot: string; changedPath: string }> = [];
    const { onAngularWorkspaceMetadataChanged } = await import('../angular-workspace-index.js');
    const unsubscribe = onAngularWorkspaceMetadataChanged((event) => events.push(event));

    expect(invalidateAngularWorkspaceForPath(projectRoot, 'src/main.ts')).toBe(false);
    expect(invalidateAngularWorkspaceForPath(projectRoot, 'package.json')).toBe(true);
    expect(events).toHaveLength(1);
    expect(events[0]?.projectRoot).toBe(getAngularWorkspaceIndex(projectRoot).projectRoot);
    expect(events[0]?.changedPath).toMatch(/package\.json$/);

    unsubscribe();
    invalidateAngularWorkspaceForPath(projectRoot, 'angular.json');
    expect(events).toHaveLength(1);
  });

  it('expires cached metadata by TTL and changes the fingerprint with the installed version', () => {
    const projectRoot = root();
    packageJson(projectRoot, { '@angular/core': '^18.0.0' });
    write(join(projectRoot, 'angular.json'), {});
    touch(join(projectRoot, 'src', 'main.ts'));
    let now = 1_000;
    const options = { ttlMs: 50, now: () => now };
    const before = resolveAngularWorkspace(projectRoot, 'src/main.ts', options)!;
    write(join(projectRoot, 'node_modules', '@angular', 'core', 'package.json'), {
      name: '@angular/core', version: '18.2.13',
    });
    expect(resolveAngularWorkspace(projectRoot, 'src/main.ts', options)?.version).toBe('18.x');
    now += 51;
    const after = resolveAngularWorkspace(projectRoot, 'src/main.ts', options)!;
    expect(after).toMatchObject({ version: '18.2.13', versionSource: 'installed' });
    expect(after.fingerprint).not.toBe(before.fingerprint);
  });

  it('respects scan bounds and rejects files outside the registered project', () => {
    const projectRoot = root();
    const deep = join(projectRoot, 'one', 'two', 'three');
    packageJson(deep, { '@angular/core': '^15.0.0' });
    write(join(deep, 'angular.json'), {});
    touch(join(deep, 'src', 'main.ts'));

    const bounded = { maxDepth: 2, maxDirectories: 20 };
    expect(getAngularWorkspaceIndex(projectRoot, bounded).facets).toEqual([]);
    expect(resolveAngularWorkspace(projectRoot, join(projectRoot, '..', 'outside.ts'))).toBeNull();
  });
});
