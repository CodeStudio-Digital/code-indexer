import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtempSync } from 'node:fs';
import { invalidateAngularWorkspaceIndex } from '../angular-workspace-index.js';
import { resolveAngularServerRoute } from '../angular-server-route.js';
import type { LspServerDef } from '../lsp-server-types.js';

const roots: string[] = [];

function profile(major: number, tier: LspServerDef['supportTier'] = 'full'): LspServerDef {
  return {
    id: `angular-language-server--angular-${major}`,
    familyId: 'angular-language-server',
    profileId: `angular-${major}`,
    projectRange: `>=${major}.0.0 <${major + 1}.0.0`,
    supportTier: tier,
    projectResolver: 'angular-core',
    label: 'Angular Language Service',
    languages: ['typescript', 'html'],
    role: 'overlay',
    install: { kind: 'npm', package: '@angular/language-server', version: `${major}.0.0` },
    entryRelPath: 'node_modules/@angular/language-server/index.js',
    args: [],
    launchKind: 'angular',
    sizeLabel: '~35 MB',
  };
}

function project(spec: string): { root: string; file: string } {
  const root = mkdtempSync(join(tmpdir(), 'angular-route-'));
  roots.push(root);
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'package.json'), JSON.stringify({ dependencies: { '@angular/core': spec } }));
  writeFileSync(join(root, 'angular.json'), JSON.stringify({ projects: { app: { root: '', sourceRoot: 'src' } } }));
  const file = join(root, 'src', 'app.component.ts');
  writeFileSync(file, 'export class AppComponent {}');
  return { root, file };
}

afterEach(() => {
  invalidateAngularWorkspaceIndex();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('resolveAngularServerRoute', () => {
  it('skips discovery for languages with no Angular profile, even inside an Angular project', () => {
    const { root } = project('^21.0.0');
    const now = () => { throw new Error('unexpected workspace scan'); };
    expect(resolveAngularServerRoute(root, 'README.md', [], { now })).toEqual({ state: 'not-angular' });
    expect(resolveAngularServerRoute(root, 'README.md', [], { enabled: false, now })).toEqual({ state: 'not-angular' });
  });

  it('selects the profile matching the file workspace major', () => {
    const { root, file } = project('^12.2.0');
    const route = resolveAngularServerRoute(root, file, [profile(12, 'best-effort'), profile(21)]);
    expect(route.state).toBe('selected');
    expect(route.profileId).toBe('angular-12');
    expect(route.workspace?.major).toBe(12);
  });

  it('never falls through to a newer profile for an unknown major', () => {
    const { root, file } = project('>=12');
    const route = resolveAngularServerRoute(root, file, [profile(21)]);
    expect(route.state).toBe('needs-profile');
    expect(route.def).toBeUndefined();
    expect(route.familyId).toBe('angular-language-server');
    expect(route.workspaceId).toBeTruthy();
  });

  it('reports Angular 2-8 as unsupported instead of using a modern server', () => {
    const { root, file } = project('^8.2.0');
    const route = resolveAngularServerRoute(root, file, [profile(9, 'best-effort'), profile(21)]);
    expect(route).toMatchObject({
      state: 'unsupported',
      workspace: { major: 8 },
    });
    expect(route.def).toBeUndefined();
  });

  it('uses an explicit workspace override only when detection is ambiguous', () => {
    const { root, file } = project('>=12');
    const route = resolveAngularServerRoute(root, file, [profile(12, 'best-effort'), profile(21)], {
      overrides: { '.': '12.x' },
    });
    expect(route).toMatchObject({
      state: 'selected',
      profileId: 'angular-12',
      workspace: { major: 12, versionSource: 'override' },
    });
  });

  it('can disable legacy profiles without disabling modern ones', () => {
    const { root, file } = project('^12.2.0');
    const route = resolveAngularServerRoute(root, file, [profile(12, 'best-effort')], { legacyEnabled: false });
    expect(route.state).toBe('disabled');
    expect(route.reason).toContain('Legacy Angular 12');
  });
});
