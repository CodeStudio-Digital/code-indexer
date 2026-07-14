/**
 * Opt-in git performance accelerators for the project's repo — reading and
 * toggling `core.untrackedCache` (a safe local cache) and `core.fsmonitor`
 * (git's built-in fsmonitor daemon, ≥ 2.37). Split from index.ts so the
 * config/daemon plumbing stays out of the god-file; injected with the same
 * spawn helper. Nothing here runs unless the operator flips a toggle — every
 * write is an explicit user action, and all of it is reversible.
 */

import { ApiError, type ProjectGitApi, type GitOptimizations } from '@mcp/api-bus';

interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** The slice of index.ts internals the module needs — injected, not re-implemented. */
export interface GitOptDeps {
  runGit(cwd: string, args: string[]): Promise<GitResult>;
  /** Resolve the git cwd for a project + optional selected repo. */
  resolveCwd(projectId: number, repoPath?: string): Promise<string>;
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

  // Core config writes — shared by the manual toggle and the auto-enabler.
  async function configure(
    root: string,
    opts: { untrackedCache?: boolean; fsmonitor?: boolean; startDaemon?: boolean },
  ): Promise<void> {
    const { untrackedCache, fsmonitor, startDaemon = true } = opts;
    if (untrackedCache !== undefined) {
      if (untrackedCache) {
        const test = await deps.runGit(root, ['update-index', '--test-untracked-cache']);
        if (test.code !== 0) {
          throw new ApiError('git_untracked_cache_unsupported', 412, test.stderr.trim() || 'untracked cache is not supported by this filesystem');
        }
      }
      const result = await deps.runGit(
        root,
        untrackedCache
          ? ['config', 'core.untrackedCache', 'true']
          : ['config', '--unset', 'core.untrackedCache'], // exit 5 if unset — harmless
      );
      if (result.code !== 0 && !(untrackedCache === false && result.code === 5)) {
        throw new ApiError('git_config_failed', 500, result.stderr.trim() || 'failed to configure core.untrackedCache');
      }
    }
    if (fsmonitor === true) {
      // Refuse to enable on git < 2.37: there `core.fsmonitor=true` is read as
      // a hook PATH (not the built-in daemon) and would BREAK `git status`.
      // The UI gates this, but the backend must not trust the caller. When
      // unsupported we skip silently — read() returns fsmonitorSupported:false
      // so the UI shows why it stayed off.
      if (!(await gitVersion(root)).supported) {
        throw new ApiError('git_fsmonitor_unsupported', 412, 'built-in fsmonitor requires Git 2.37 or newer');
      }
      {
        const configured = await deps.runGit(root, ['config', 'core.fsmonitor', 'true']);
        if (configured.code !== 0) throw new ApiError('git_config_failed', 500, configured.stderr.trim() || 'failed to configure core.fsmonitor');
        // The manual toggle eager-starts the daemon (snappy now). The auto-
        // enabler passes startDaemon:false and lets git lazily start it on the
        // next status — avoids spawning a persistent daemon for every repo the
        // user merely visits.
        if (startDaemon) {
          const started = await deps.runGit(root, ['fsmonitor--daemon', 'start']);
          if (started.code !== 0) throw new ApiError('git_fsmonitor_start_failed', 500, started.stderr.trim() || 'failed to start fsmonitor daemon');
        }
      }
    } else if (fsmonitor === false) {
      const unset = await deps.runGit(root, ['config', '--unset', 'core.fsmonitor']);
      if (unset.code !== 0 && unset.code !== 5) throw new ApiError('git_config_failed', 500, unset.stderr.trim() || 'failed to disable core.fsmonitor');
      await deps.runGit(root, ['fsmonitor--daemon', 'stop']); // non-fatal if not running
    }
  }

  return {
    async gitOptimizations({ projectId, repoPath }) {
      return read(await deps.resolveCwd(projectId, repoPath));
    },

    async configureGitOptimizations({ projectId, untrackedCache, fsmonitor, repoPath }) {
      const root = await deps.resolveCwd(projectId, repoPath);
      const before = await read(root);
      try {
        await configure(root, { untrackedCache, fsmonitor });
        const after = await read(root);
        if (untrackedCache !== undefined && after.untrackedCache !== untrackedCache) throw new ApiError('git_config_verify_failed', 500, 'core.untrackedCache did not retain the requested value');
        if (fsmonitor !== undefined && after.fsmonitor !== fsmonitor) throw new ApiError('git_config_verify_failed', 500, 'core.fsmonitor did not retain the requested value');
        return after;
      } catch (error) {
        // Best-effort rollback: never leave one half of a two-toggle update
        // applied after the other half failed.
        try {
          await configure(root, {
            ...(untrackedCache !== undefined ? { untrackedCache: before.untrackedCache } : {}),
            ...(fsmonitor !== undefined ? { fsmonitor: before.fsmonitor } : {}),
            startDaemon: before.fsmonitor,
          });
        } catch { /* preserve the original actionable error */ }
        throw error;
      }
    },
  };
}
