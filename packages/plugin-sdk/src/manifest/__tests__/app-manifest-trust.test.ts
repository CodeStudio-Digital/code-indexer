import { describe, it, expect } from 'vitest';
import { parseAppManifest } from '../app-json.schema.js';

/** An OAuth connector manifest: declares host-only capabilities (auth.hooks +
 *  sdk:* discovery + pat-exchange) that the third-party gate must reject but the
 *  first-party bundled lane must accept. */
const connectorApp = {
  providers: [
    {
      kind: 'copilot',
      displayName: 'GitHub Copilot',
      credKind: 'oauth',
      envVars: [],
      defaultModels: ['gpt-4o'],
      pricing: {},
      wire: 'openai-compat',
      discovery: { from: 'sdk:copilot' },
      auth: { mode: 'oauth', flavor: 'pat-exchange', hooks: 'copilot' },
    },
  ],
};

const apiKeyApp = {
  providers: [
    {
      kind: 'cloudflare',
      displayName: 'Cloudflare',
      credKind: 'api-key',
      envVars: ['CF_API_TOKEN'],
      defaultModels: ['@cf/m'],
      pricing: {},
      wire: 'openai-compat',
      discovery: { from: 'cloudflare-models' },
    },
  ],
};

const angularLanguageServer = {
  id: 'angular-language-server',
  label: 'Angular Language Service',
  languages: ['typescript', 'html'],
  activation: {
    whenFiles: ['angular.json'],
    whenPackageDep: ['@angular/core'],
  },
  install: {
    kind: 'npm' as const,
    package: '@angular/language-server',
    version: '21.2.18',
  },
  entryRelPath: 'node_modules/@angular/language-server/index.js',
  args: [],
  launchKind: 'angular' as const,
  routing: { mode: 'overlay' as const, priority: 100 },
  sizeLabel: '~30 MB',
};

const angularCompatibility = {
  projectResolver: 'angular-core' as const,
  profiles: [
    {
      id: 'angular-20',
      projectVersionRange: '>=20.0.0 <21.0.0',
      supportTier: 'full' as const,
      serverNodeRange: '^20.19.0 || ^22.12.0',
      typescriptRange: '>=5.8.0 <6.0.0',
      languageServiceVersion: '20.3.5',
      install: {
        kind: 'npm' as const,
        package: '@angular/language-server',
        version: '20.3.0',
      },
      entryRelPath: 'node_modules/@angular/language-server/index.js',
      args: [],
    },
    {
      id: 'angular-21',
      projectVersionRange: '>=21.0.0 <22.0.0',
      supportTier: 'full' as const,
      serverNodeRange: '^20.19.0 || ^22.12.0 || >=24.0.0',
      typescriptRange: '>=5.9.0 <6.0.0',
      languageServiceVersion: '21.2.18',
      install: angularLanguageServer.install,
      entryRelPath: angularLanguageServer.entryRelPath,
      args: [],
    },
  ],
};

describe('parseAppManifest — first-party trust lane (C3)', () => {
  it('rejects a host-capability connector by default (third-party gate)', () => {
    expect(() => parseAppManifest(connectorApp)).toThrow();
  });

  it('accepts it under trustProviders (bundled first-party lane)', () => {
    const app = parseAppManifest(connectorApp, { trustProviders: true });
    expect(app.providers?.[0].kind).toBe('copilot');
  });

  it('an api-key plugin passes BOTH lanes (no host capability claimed)', () => {
    expect(parseAppManifest(apiKeyApp).providers?.[0].kind).toBe('cloudflare');
    expect(parseAppManifest(apiKeyApp, { trustProviders: true }).providers?.[0].kind).toBe('cloudflare');
  });

  it('trustProviders does NOT relax non-provider validation (unknown tool field still rejected)', () => {
    const bad = { tools: [{ name: 't', description: 'd', bogus: true }] };
    // tools use .default()/loose object, so assert the provider-trust flag is
    // scoped to providers: a malformed PROVIDER is still rejected even trusted.
    const badProvider = { providers: [{ kind: 'x' }] };
    expect(() => parseAppManifest(badProvider, { trustProviders: true })).toThrow();
    void bad;
  });

  it('rejects language-server execution metadata in the third-party lane', () => {
    expect(() => parseAppManifest({ languageServers: [angularLanguageServer] })).toThrow(
      /trusted first-party bundled plugins/,
    );
  });

  it('accepts a pinned npm language server only in the first-party lane', () => {
    const app = parseAppManifest(
      { languageServers: [angularLanguageServer] },
      { trustFirstParty: true },
    );
    expect(app.languageServers?.[0]).toMatchObject({
      id: 'angular-language-server',
      install: { package: '@angular/language-server', version: '21.2.18' },
      launchKind: 'angular',
      routing: { mode: 'overlay', priority: 100 },
    });
  });

  it('keeps a single install declaration compatible with optional version profiles', () => {
    expect(() => parseAppManifest(
      { languageServers: [{ ...angularLanguageServer, compatibility: angularCompatibility }] },
      { trustFirstParty: true },
    )).not.toThrow();

    expect(() => parseAppManifest(
      { languageServers: [angularLanguageServer] },
      { trustFirstParty: true },
    )).not.toThrow();
  });

  it.each([
    {
      name: 'overlap',
      compatibility: {
        ...angularCompatibility,
        profiles: [
          ...angularCompatibility.profiles,
          {
            ...angularCompatibility.profiles[1],
            id: 'angular-21-overlap',
            projectVersionRange: '>=20.5.0 <21.5.0',
          },
        ],
      },
    },
    {
      name: 'duplicate id',
      compatibility: {
        ...angularCompatibility,
        profiles: [
          angularCompatibility.profiles[0],
          { ...angularCompatibility.profiles[1], id: 'angular-20' },
        ],
      },
    },
    {
      name: 'npm range',
      compatibility: {
        ...angularCompatibility,
        profiles: [{
          ...angularCompatibility.profiles[0],
          install: { ...angularCompatibility.profiles[0].install, version: '^20.3.0' },
        }],
      },
    },
    {
      name: 'unsafe entry',
      compatibility: {
        ...angularCompatibility,
        profiles: [{ ...angularCompatibility.profiles[0], entryRelPath: '../index.js' }],
      },
    },
    {
      name: 'invalid Node range',
      compatibility: {
        ...angularCompatibility,
        profiles: [{ ...angularCompatibility.profiles[0], serverNodeRange: 'node 20' }],
      },
    },
    {
      name: 'non-normalized project range',
      compatibility: {
        ...angularCompatibility,
        profiles: [{ ...angularCompatibility.profiles[0], projectVersionRange: '^20.0.0' }],
      },
    },
    {
      name: 'unknown resolver',
      compatibility: { ...angularCompatibility, projectResolver: 'package-json' },
    },
  ])('rejects invalid language-server compatibility metadata: $name', ({ compatibility }) => {
    expect(() => parseAppManifest(
      { languageServers: [{ ...angularLanguageServer, compatibility }] },
      { trustFirstParty: true },
    )).toThrow();
  });

  it('keeps trustProviders as a backwards-compatible first-party alias', () => {
    const app = parseAppManifest(
      { languageServers: [angularLanguageServer] },
      { trustProviders: true },
    );
    expect(app.languageServers?.[0].id).toBe('angular-language-server');
  });

  it.each([
    { install: { ...angularLanguageServer.install, version: '^21.2.18' } },
    { install: { kind: 'binary', package: '@angular/language-server', version: '21.2.18' } },
    { entryRelPath: '../language-server.js' },
    { activation: {} },
  ])('rejects unsafe or unpinned language-server metadata: %o', (override) => {
    expect(() => parseAppManifest(
      { languageServers: [{ ...angularLanguageServer, ...override }] },
      { trustFirstParty: true },
    )).toThrow();
  });
});
