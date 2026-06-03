/**
 * Clone an arbitrary repo into `~/.mcp-code-indexer/projects/<slug>`. A shallow clone
 * keeps it fast; the user keeps full history controls in the IDE git UI
 * afterwards. `repoUrl` is validated in `../validate.ts` BEFORE reaching
 * here — only `https://`, `ssh://`, or `git@…` forms are allowed and any
 * leading-dash injection is rejected, so it's safe as a positional arg.
 */
import { CLI_TIMEOUT_MS, type HostTemplate } from './types.js';

export const gitCloneTemplate: HostTemplate = {
  id: 'git-clone',
  needsNetwork: true,
  requiresRepoUrl: true,
  createsTargetDir: false, // git clone makes the dir
  build: ({ slug, repoUrl }) => [
    {
      phase: 'run-cli',
      program: 'git',
      args: ['clone', '--depth', '1', repoUrl as string, slug],
      cwd: 'parent',
      timeoutMs: CLI_TIMEOUT_MS,
      label: 'git clone',
    },
  ],
};
