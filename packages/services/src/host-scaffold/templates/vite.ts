/**
 * Vite-based templates (React, Vue) via the official `create-vite`. The
 * CLI scaffolds the slug dir in the parent; we add an explicit install
 * step (create-vite intentionally skips it).
 */
import { CLI_TIMEOUT_MS, INSTALL_TIMEOUT_MS, type HostTemplate } from './types.js';

function viteTemplate(id: 'react-vite' | 'vue', viteTemplateName: string): HostTemplate {
  return {
    id,
    needsNetwork: true,
    createsTargetDir: false, // create-vite makes the dir
    build: ({ slug }) => [
      {
        phase: 'run-cli',
        program: 'npm',
        args: ['create', 'vite@latest', slug, '--', '--template', viteTemplateName],
        cwd: 'parent',
        timeoutMs: CLI_TIMEOUT_MS,
        label: `create-vite (${viteTemplateName})`,
      },
      {
        phase: 'install-deps',
        program: 'npm',
        args: ['install', '--no-audit', '--no-fund'],
        cwd: 'target',
        timeoutMs: INSTALL_TIMEOUT_MS,
        label: 'npm install',
      },
    ],
  };
}

export const reactViteTemplate = viteTemplate('react-vite', 'react-ts');
export const vueTemplate = viteTemplate('vue', 'vue-ts');
