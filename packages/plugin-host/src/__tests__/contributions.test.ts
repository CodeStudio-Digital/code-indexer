import { describe, expect, it } from 'vitest';
import { parseAppManifest } from '@mcp/plugin-sdk';
import { buildContributions } from '../apply/contributions.js';

describe('buildContributions', () => {
  it('normalizes a trusted language server into the installed snapshot', () => {
    const app = parseAppManifest({
      languageServers: [{
        id: 'angular-language-server',
        label: 'Angular Language Service',
        languages: ['typescript', 'html'],
        activation: { whenFiles: ['angular.json'], whenPackageDep: ['@angular/core'] },
        install: { kind: 'npm', package: '@angular/language-server', version: '21.2.18' },
        entryRelPath: 'node_modules/@angular/language-server/index.js',
        args: [],
        launchKind: 'angular',
        routing: { mode: 'overlay', priority: 100 },
        sizeLabel: '~35 MB',
      }],
    }, { trustFirstParty: true });

    const snapshot = buildContributions(app);
    expect(snapshot?.languageServers).toEqual(app.languageServers);
    expect(snapshot?.tools).toEqual([]);
    expect(snapshot?.worker).toBeNull();
  });
});
