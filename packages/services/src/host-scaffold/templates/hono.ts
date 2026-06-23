/**
 * Hono API backend via the official `create-hono` (Node.js template).
 * `--install` makes the CLI install deps, `--pm npm` pins the package
 * manager, `--template nodejs` skips the interactive template prompt.
 * Mirrors the intent of the container `vite-api` scaffolder (a pure API
 * backend) without authoring files by hand.
 */
import { INSTALL_TIMEOUT_MS, type HostTemplate } from './types.js';

export const honoApiTemplate: HostTemplate = {
  id: 'vite-api',
  needsNetwork: true,
  createsTargetDir: false, // create-hono makes the dir
  build: ({ slug }) => [
    {
      phase: 'run-cli',
      program: 'npm',
      args: ['create', 'hono@latest', slug, '--', '--template', 'nodejs', '--install', '--pm', 'npm'],
      cwd: 'parent',
      timeoutMs: INSTALL_TIMEOUT_MS, // includes the install
      label: 'create-hono (nodejs)',
    },
  ],
};
