/**
 * Angular via the official Angular CLI. `ng new` scaffolds AND installs
 * in one shot. `--defaults` accepts the routing/style defaults (no
 * prompt), `--skip-git` avoids needing a configured git identity, and
 * analytics is silenced via `NG_CLI_ANALYTICS` in the shared env. `npx -y`
 * auto-installs the CLI itself.
 */
import { INSTALL_TIMEOUT_MS, type HostTemplate } from './types.js';

export const angularTemplate: HostTemplate = {
  id: 'angular',
  needsNetwork: true,
  createsTargetDir: false, // ng new makes the dir
  build: ({ slug }) => [
    {
      phase: 'run-cli',
      program: 'npx',
      args: ['-y', '@angular/cli@latest', 'new', slug, '--defaults', '--skip-git'],
      cwd: 'parent',
      timeoutMs: INSTALL_TIMEOUT_MS, // ng new installs too
      label: 'ng new',
    },
  ],
};
