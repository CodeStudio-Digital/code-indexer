/**
 * Empty project — no stack. The runner creates the directory itself
 * (`createsTargetDir: true`); we optionally `git init` it. Useful as a
 * blank canvas the user fills in, or a target for manual file drops.
 */
import { QUICK_TIMEOUT_MS, type HostStep, type HostTemplate } from './types.js';

export const emptyTemplate: HostTemplate = {
  id: 'empty',
  needsNetwork: false,
  createsTargetDir: true,
  build: ({ gitInit }): HostStep[] =>
    gitInit
      ? [
          {
            phase: 'git-init',
            program: 'git',
            args: ['init'],
            cwd: 'target',
            timeoutMs: QUICK_TIMEOUT_MS,
            label: 'git init',
          },
        ]
      : [],
};
