import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  allLspServerProfiles,
  installDirFor,
  lspServersForFamily,
  overlayServersForLanguage,
  replacePluginLanguageServers,
  serverById,
  type PluginLanguageServerSnapshot,
} from '../server-registry.js';

const FAMILY_ID = 'angular-language-server';
const ENTRY = 'node_modules/@angular/language-server/index.js';
const FALLBACK_ARGS = ['--includeCompletionsForModuleExports', 'true'];

function angularContribution(
  legacyRange = '>=9.0.0 <10.0.0',
  legacyServerVersion = '0.901.11',
): PluginLanguageServerSnapshot {
  return {
    id: FAMILY_ID,
    label: 'Angular Language Service',
    languages: ['typescript', 'html'],
    routing: { mode: 'overlay', priority: 100 },
    install: { kind: 'npm', package: '@angular/language-server', version: '21.2.18' },
    entryRelPath: ENTRY,
    launchKind: 'angular',
    args: FALLBACK_ARGS,
    activation: { whenFiles: ['angular.json'], whenPackageDep: ['@angular/core'] },
    sizeLabel: '~35 MB',
    compatibility: {
      projectResolver: 'angular-core',
      profiles: [
        {
          id: 'angular-9',
          projectVersionRange: legacyRange,
          supportTier: 'best-effort',
          serverNodeRange: '>=10.9.0 <13.0.0',
          typescriptRange: '>=3.6.0 <3.9.0',
          languageServiceVersion: '9.1.11',
          install: { kind: 'npm', package: '@angular/language-server', version: legacyServerVersion },
          entryRelPath: ENTRY,
          args: [],
        },
        {
          id: 'angular-21',
          projectVersionRange: '>=21.0.0 <22.0.0',
          supportTier: 'full',
          serverNodeRange: '^20.19.0 || ^22.12.0 || >=24.0.0',
          typescriptRange: '>=5.9.0 <6.0.0',
          languageServiceVersion: '21.2.18',
          install: { kind: 'npm', package: '@angular/language-server', version: '21.2.18' },
          entryRelPath: ENTRY,
          args: FALLBACK_ARGS,
        },
      ],
    },
  };
}

afterEach(() => {
  replacePluginLanguageServers([]);
});

describe('plugin language-server compatibility profiles', () => {
  it('keeps legacy single-server contributions addressable by their original id', () => {
    const contribution = angularContribution();
    delete contribution.compatibility;

    const result = replacePluginLanguageServers([{ namespace: 'angular', contribution }]);

    expect(result.active).toEqual([FAMILY_ID]);
    expect(serverById(FAMILY_ID)).toEqual(expect.objectContaining({
      id: FAMILY_ID,
      pluginNamespace: 'angular',
    }));
    expect(serverById(FAMILY_ID)?.familyId).toBeUndefined();
    expect(allLspServerProfiles()).toEqual([]);
    expect(lspServersForFamily(FAMILY_ID).map((server) => server.id)).toEqual([FAMILY_ID]);
  });

  it('rehydrates a family into deterministic side-by-side effective profiles', () => {
    const result = replacePluginLanguageServers([{
      namespace: 'angular',
      contribution: angularContribution(),
    }]);

    expect(result.active).toEqual([
      `${FAMILY_ID}--angular-9`,
      `${FAMILY_ID}--angular-21`,
    ]);
    expect(serverById(FAMILY_ID)).toBeUndefined();
    expect(serverById(`${FAMILY_ID}--angular-9`)).toEqual(expect.objectContaining({
      storageId: FAMILY_ID,
      familyId: FAMILY_ID,
      profileId: 'angular-9',
      projectRange: '>=9.0.0 <10.0.0',
      supportTier: 'best-effort',
      serverNodeRange: '>=10.9.0 <13.0.0',
      projectResolver: 'angular-core',
      defaultProfile: false,
    }));
    expect(serverById(`${FAMILY_ID}--angular-21`)).toEqual(expect.objectContaining({
      storageId: FAMILY_ID,
      profileId: 'angular-21',
      languageServiceVersion: '21.2.18',
      defaultProfile: true,
    }));
    expect(allLspServerProfiles().map((server) => server.profileId))
      .toEqual(['angular-9', 'angular-21']);
    expect(lspServersForFamily(FAMILY_ID).map((server) => server.profileId))
      .toEqual(['angular-9', 'angular-21']);
  });

  it('uses the declared modern fallback when routing has no file version context', () => {
    const root = mkdtempSync(join(tmpdir(), 'mcp-angular-profile-fallback-'));
    try {
      writeFileSync(join(root, 'angular.json'), '{}');
      replacePluginLanguageServers([{
        namespace: 'angular',
        contribution: angularContribution(),
      }]);

      expect(overlayServersForLanguage('typescript', root).map((server) => server.id))
        .toEqual([`${FAMILY_ID}--angular-21`]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('isolates duplicate physical versions while preserving the fallback directory', () => {
    replacePluginLanguageServers([{
      namespace: 'angular',
      contribution: angularContribution('>=9.0.0 <10.0.0', '21.2.18'),
    }]);
    const legacy = serverById(`${FAMILY_ID}--angular-9`)!;
    const fallback = serverById(`${FAMILY_ID}--angular-21`)!;
    const baseDir = join('lsp-root');

    expect(legacy.storageId).toBe(`${FAMILY_ID}--angular-9`);
    expect(fallback.storageId).toBe(FAMILY_ID);
    expect(installDirFor(baseDir, legacy)).not.toBe(installDirFor(baseDir, fallback));
    expect(installDirFor(baseDir, fallback)).toBe(join(baseDir, `${FAMILY_ID}@21.2.18`));
  });

  it('reports metadata-only profile changes through the registry fingerprint', () => {
    replacePluginLanguageServers([{
      namespace: 'angular',
      contribution: angularContribution(),
    }]);

    const changed = replacePluginLanguageServers([{
      namespace: 'angular',
      contribution: angularContribution('>=9.0.0 <9.2.0'),
    }]);

    expect(changed.added).toEqual([]);
    expect(changed.removed).toEqual([]);
    expect(changed.changed).toEqual([`${FAMILY_ID}--angular-9`]);
  });

  it('degrades invalid profile metadata to the approved single fallback', () => {
    const contribution = angularContribution('>=9.0.0 <22.0.0');
    const result = replacePluginLanguageServers([{ namespace: 'angular', contribution }]);

    expect(result.active).toEqual([FAMILY_ID]);
    expect(serverById(FAMILY_ID)?.install).toEqual({
      kind: 'npm',
      package: '@angular/language-server',
      version: '21.2.18',
    });
    expect(allLspServerProfiles()).toEqual([]);
  });
});
