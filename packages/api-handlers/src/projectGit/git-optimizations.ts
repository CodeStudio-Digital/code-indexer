/**
 * Opt-in git performance accelerators for the project's repo — reading and
 * toggling `core.untrackedCache` (a safe local cache) and `core.fsmonitor`
 * (git's built-in fsmonitor daemon, ≥ 2.37). Split from index.ts so the
 * config/daemon plumbing stays out of the god-file; injected with the same
 * spawn helper. Nothing here runs unless the operator flips a toggle — every
 * write is an explicit user action, and all of it is reversible.
 */

import type { ProjectGitApi, GitOptimizations } from '@mcp/api-bus';

interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** The slice of index.ts internals the module needs — injected, not re-implemented. */
export interface GitOptDeps {
  runGit(cwd: string, args: string[]): Promise<GitResult>;
  requireRoot(projectId: number): string;
}

type GitOptApi = Pick<ProjectGitApi, 'gitOptimizations' | 'configureGitOptimizations'>;

/** "git version 2.45.1.windows.1" → [2, 45]. */
function parseVersion(s: string): [number, number] {
  const m = s.match(/(\d+)\.(\d+)/);
  return m ? [Number(m[1]), Number(m[2])] : [0, 0];
}

async function readBool(runGit: GitOptDeps['runGit'], root: string, key: string): Promise<boolean> {
  const r = await runGit(root, ['config', '--get', key]);
  return r.code === 0 && r.stdout.trim() === 'true';
}

export function createGitOptimizationHandlers(deps: GitOptDeps): GitOptApi {
  async function gitVersion(root: string): Promise<{ raw: string; supported: boolean }> {
    const raw = (await deps.runGit(root, ['--version'])).stdout.trim();
    const [maj, min] = parseVersion(raw);
    // The built-in fsmonitor daemon (no external Watchman) shipped in 2.37.
    return { raw, supported: maj > 2 || (maj === 2 && min >= 37) };
  }

  async function read(root: string): Promise<GitOptimizations> {
    const { raw, supported } = await gitVersion(root);
    const [untrackedCache, fsmonitor] = await Promise.all([
      readBool(deps.runGit, root, 'core.untrackedCache'),
      readBool(deps.runGit, root, 'core.fsmonitor'),
    ]);
    return {
      untrackedCache,
      fsmonitor,
      gitVersion: raw.replace(/^git version /, ''),
      fsmonitorSupported: supported,
    };
  }

  return {
    async gitOptimizations({ projectId }) {
      return read(deps.requireRoot(projectId));
    },

    async configureGitOptimizations({ projectId, untrackedCache, fsmonitor }) {
      const root = deps.requireRoot(projectId);
      if (untrackedCache !== undefined) {
        await deps.runGit(
          root,
          untrackedCache
            ? ['config', 'core.untrackedCache', 'true']
            : ['config', '--unset', 'core.untrackedCache'], // exit 5 if unset — harmless
        );
      }
      if (fsmonitor === true) {
        // Refuse to enable on git < 2.37: there `core.fsmonitor=true` is read as
        // a hook PATH (not the built-in daemon) and would BREAK `git status`.
        // The UI gates this, but the backend must not trust the caller. When
        // unsupported we skip silently — read() returns fsmonitorSupported:false
        // so the UI shows why it stayed off.
        if ((await gitVersion(root)).supported) {
          await deps.runGit(root, ['config', 'core.fsmonitor', 'true']);
          // git auto-starts the daemon on the next command, but starting it
          // here makes the first status fast too. Best-effort; non-fatal.
          await deps.runGit(root, ['fsmonitor--daemon', 'start']);
        }
      } else if (fsmonitor === false) {
        await deps.runGit(root, ['config', '--unset', 'core.fsmonitor']);
        await deps.runGit(root, ['fsmonitor--daemon', 'stop']); // non-fatal if not running
      }
      return read(root);
    },
  };
}
