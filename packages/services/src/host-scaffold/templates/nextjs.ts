/**
 * Standalone Next.js via the official `create-next-app`. All meaningful
 * options are passed explicitly (so no prompt fires) and `--yes` mops up
 * any remaining defaults (e.g. Turbopack) — this combination is the
 * reliable non-interactive form per the Next.js CLI docs. create-next-app
 * installs deps itself.
 */
import { CLI_TIMEOUT_MS, type HostTemplate } from './types.js';

export const nextjsTemplate: HostTemplate = {
  id: 'nextjs',
  needsNetwork: true,
  createsTargetDir: false, // create-next-app makes the dir
  build: ({ slug }) => [
    {
      phase: 'run-cli',
      program: 'npx',
      args: [
        '-y',
        'create-next-app@latest',
        slug,
        '--ts',
        '--eslint',
        '--app',
        '--src-dir',
        '--no-tailwind',
        '--import-alias',
        '@/*',
        '--use-npm',
        '--yes',
      ],
      cwd: 'parent',
      timeoutMs: CLI_TIMEOUT_MS,
      label: 'create-next-app',
    },
  ],
};
