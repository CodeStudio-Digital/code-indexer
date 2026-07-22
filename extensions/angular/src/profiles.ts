import type {
  LanguageServerCompatibilityProfile,
  LanguageServerSupportTier,
} from '@mcp/plugin-sdk/define.js';

const serverPackage = '@angular/language-server';
const serverEntry = 'node_modules/@angular/language-server/index.js';

function completionArgs(): string[] {
  return [
    '--includeAutomaticOptionalChainCompletions',
    '--includeCompletionsWithSnippetText',
    '--includeCompletionsForModuleExports',
    'true',
  ];
}

function profile(
  angularMajor: number,
  serverVersion: string,
  languageServiceVersion: string,
  supportTier: LanguageServerSupportTier,
  serverNodeRange: string,
  typescriptRange: string,
): LanguageServerCompatibilityProfile {
  return {
    id: `angular-${angularMajor}`,
    projectVersionRange: `>=${angularMajor}.0.0 <${angularMajor + 1}.0.0`,
    supportTier,
    serverNodeRange,
    typescriptRange,
    languageServiceVersion,
    install: { kind: 'npm', package: serverPackage, version: serverVersion },
    entryRelPath: serverEntry,
    // Legacy servers negotiate a smaller capability set and receive no newer
    // completion switches. The host still injects probes and --stdio.
    args: angularMajor >= 15 ? completionArgs() : [],
  };
}

/**
 * Pinned from the official npm package metadata. Angular 2-8 intentionally do
 * not appear here: @angular/language-server was first published for Angular 9
 * and older projects need a separate tsserver bridge.
 */
export const angularCompatibilityProfiles: LanguageServerCompatibilityProfile[] = [
  profile(9, '0.901.11', '9.1.11', 'best-effort', '>=10.9.0 <13.0.0', '>=3.6.0 <3.9.0'),
  profile(10, '0.1001.1', '10.2.1', 'best-effort', '>=10.9.0 <13.0.0', '>=3.9.0 <4.1.0'),
  profile(11, '11.2.14', '11.2.12', 'best-effort', '>=10.9.0 <15.0.0', '>=4.0.0 <4.2.0'),
  profile(12, '12.2.3', '12.2.12', 'best-effort', '>=10.9.0 <15.0.0', '>=4.2.3 <4.4.0'),
  profile(13, '13.3.4', '13.3.8', 'best-effort', '^12.20.0 || ^14.15.0 || >=16.10.0', '>=4.4.3 <4.7.0'),
  profile(14, '14.2.0', '14.2.0', 'best-effort', '^14.15.0 || >=16.10.0', '>=4.6.2 <4.9.0'),
  profile(15, '15.2.1', '15.2.7', 'full', '^14.20.0 || ^16.13.0 || >=18.10.0', '>=4.8.2 <5.0.0'),
  profile(16, '16.2.0', '16.2.8', 'full', '^18.13.0 || >=20.0.0', '>=4.9.3 <5.2.0'),
  profile(17, '17.3.2', '17.3.6', 'full', '^18.13.0 || >=20.0.0', '>=5.2.0 <5.5.0'),
  // The final official 18.x server package depends on 18.2.0-rc.0, so this
  // line stays best-effort until the compatibility fixture qualifies it.
  profile(18, '18.2.0', '18.2.0-rc.0', 'best-effort', '^18.19.1 || ^20.11.1', '>=5.4.0 <5.6.0'),
  profile(19, '19.2.4', '19.2.7', 'full', '^18.19.1 || ^20.11.1', '>=5.5.0 <5.9.0'),
  profile(20, '20.3.0', '20.3.5', 'full', '^20.19.0 || ^22.12.0', '>=5.8.0 <6.0.0'),
  profile(21, '21.2.18', '21.2.18', 'full', '^20.19.0 || ^22.12.0 || >=24.0.0', '>=5.9.0 <6.0.0'),
  profile(22, '22.0.7', '22.0.7', 'full', '^22.22.3 || ^24.15.0 || >=26.0.0', '>=6.0.0 <6.1.0'),
];
