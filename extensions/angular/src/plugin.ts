import {
  contributeLanguageServer,
  contributeRunConfiguration,
  definePlugin,
} from '@mcp/plugin-sdk/define.js';
import { angularCompatibilityProfiles } from './profiles.js';

const angularProject = {
  // ActivationRule has OR semantics: either the workspace marker or the
  // package dependency is enough to identify an Angular project.
  whenFiles: ['angular.json'],
  whenPackageDep: ['@angular/core'],
};

export default definePlugin({
  languageServers: [
    contributeLanguageServer({
      id: 'angular-language-server',
      label: 'Angular Language Service',
      // The official Angular LS document selector is TypeScript + HTML.
      languages: ['typescript', 'html'],
      activation: angularProject,
      install: {
        kind: 'npm',
        package: '@angular/language-server',
        version: '21.2.18',
      },
      entryRelPath: 'node_modules/@angular/language-server/index.js',
      // Project/install probes and --stdio are injected by the host-owned
      // Angular launcher. These completion flags are static and shell-free.
      args: [
        '--includeAutomaticOptionalChainCompletions',
        '--includeCompletionsWithSnippetText',
        '--includeCompletionsForModuleExports',
        'true',
      ],
      launchKind: 'angular',
      compatibility: {
        projectResolver: 'angular-core',
        profiles: angularCompatibilityProfiles,
      },
      routing: {
        mode: 'overlay',
        priority: 100,
      },
      sizeLabel: '~35 MB',
    }),
  ],
  runConfigurations: [
    contributeRunConfiguration({
      id: 'angular-serve',
      title: 'Angular: Serve',
      kind: 'angular',
      command: 'npx',
      args: ['--no-install', 'ng', 'serve'],
      scope: 'project',
      activation: angularProject,
    }),
    contributeRunConfiguration({
      id: 'angular-build',
      title: 'Angular: Build',
      kind: 'angular',
      command: 'npx',
      args: ['--no-install', 'ng', 'build'],
      scope: 'project',
      activation: angularProject,
    }),
    contributeRunConfiguration({
      id: 'angular-test',
      title: 'Angular: Test',
      kind: 'angular',
      command: 'npx',
      args: ['--no-install', 'ng', 'test'],
      scope: 'project',
      activation: angularProject,
    }),
  ],
});
