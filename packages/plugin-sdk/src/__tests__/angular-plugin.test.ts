import { describe, expect, it } from 'vitest';
import plugin from '../../../../extensions/angular/src/plugin.js';
import { parseAppManifest } from '@mcp/plugin-sdk';

describe('Angular first-party plugin', () => {
  it('declares the pinned Angular language server as an overlay', () => {
    expect(plugin.languageServers).toHaveLength(1);
    expect(plugin.languageServers[0]).toMatchObject({
      id: 'angular-language-server',
      languages: ['typescript', 'html'],
      install: {
        kind: 'npm',
        package: '@angular/language-server',
        version: '21.2.18',
      },
      entryRelPath: 'node_modules/@angular/language-server/index.js',
      args: [
        '--includeAutomaticOptionalChainCompletions',
        '--includeCompletionsWithSnippetText',
        '--includeCompletionsForModuleExports',
        'true',
      ],
      launchKind: 'angular',
      routing: { mode: 'overlay', priority: 100 },
    });
  });

  it('passes the trusted manifest contract', () => {
    const app = parseAppManifest(
      { languageServers: plugin.languageServers },
      { trustFirstParty: true },
    );
    expect(app.languageServers?.[0].activation).toEqual({
      whenFiles: ['angular.json'],
      whenPackageDep: ['@angular/core'],
    });
  });

  it('pins non-overlapping Angular 9-22 compatibility profiles', () => {
    const compatibility = plugin.languageServers[0].compatibility;
    expect(compatibility?.projectResolver).toBe('angular-core');
    expect(compatibility?.profiles).toHaveLength(14);

    const profiles = compatibility?.profiles ?? [];
    expect(profiles.map((profile) => profile.id)).toEqual(
      Array.from({ length: 14 }, (_, index) => `angular-${index + 9}`),
    );
    expect(profiles.map((profile) => profile.install.version)).toEqual([
      '0.901.11',
      '0.1001.1',
      '11.2.14',
      '12.2.3',
      '13.3.4',
      '14.2.0',
      '15.2.1',
      '16.2.0',
      '17.3.2',
      '18.2.0',
      '19.2.4',
      '20.3.0',
      '21.2.18',
      '22.0.7',
    ]);
    expect(profiles.find((profile) => profile.id === 'angular-18')).toMatchObject({
      supportTier: 'best-effort',
      languageServiceVersion: '18.2.0-rc.0',
    });
    expect(profiles.filter((profile) => profile.supportTier === 'best-effort').map((profile) => profile.id))
      .toEqual(['angular-9', 'angular-10', 'angular-11', 'angular-12', 'angular-13', 'angular-14', 'angular-18']);
    expect(profiles.every((profile) => profile.entryRelPath === 'node_modules/@angular/language-server/index.js'))
      .toBe(true);
    expect(profiles.some((profile) => profile.id === 'angular-8')).toBe(false);
  });

  it('contributes the standard Angular CLI project runs', () => {
    expect(plugin.runConfigurations).toEqual([
      expect.objectContaining({
        id: 'angular-serve', command: 'npx', args: ['--no-install', 'ng', 'serve'], kind: 'angular',
      }),
      expect.objectContaining({
        id: 'angular-build', command: 'npx', args: ['--no-install', 'ng', 'build'], kind: 'angular',
      }),
      expect.objectContaining({
        id: 'angular-test', command: 'npx', args: ['--no-install', 'ng', 'test'], kind: 'angular',
      }),
    ]);
    expect(plugin.runConfigurations.every((run) => run.activation === plugin.languageServers[0].activation)).toBe(true);
  });
});
