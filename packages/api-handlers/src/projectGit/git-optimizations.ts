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
  /** Resolve the git cwd for a project + optional selected repo. */
  resolveCwd(projectId: number, repoPath?: string): Promise<string>;
}

type GitOptApi = Pick<ProjectGitApi, 'gitOptimizations' | 'configureGitOptimizations'> & {
  /**
   * Fire-and-forget: enable `core.fsmonitor` + `core.untrackedCache` the first
   * time a repo is seen, so cold `git status` (10-20s on a large/Defender repo)
   * drops to <1s once the daemon warms. Idempotent — a `codestudio.gitautooptimized`
   * sentinel + an in-process Set make it run exactly once per repo, and a prior
   * sentinel means a later manual GitPerfPanel toggle is never re-fought.
   * Opt out with `MCP_GIT_AUTO_OPTIMIZE=0`. NOT part of the IPC surface.
   */
  ensureAutoOptimized(repoRoot: string): Promise<void>;
};

function autoOptimizeDisabled(): boolean {
  const v = (process.env.MCP_GIT_AUTO_OPTIMIZE ?? '').toLowerCase();
  return v === '0' || v === 'false' || v === 'no' || v === 'off';
}

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
        // The manual toggle eager-starts the daemon (snappy now). The auto-
        // enabler passes startDaemon:false and lets git lazily start it on the
        // next status — avoids spawning a persistent daemon for every repo the
        // user merely visits.
        if (startDaemon) await deps.runGit(root, ['fsmonitor--daemon', 'start']);
      }
    } else if (fsmonitor === false) {
      await deps.runGit(root, ['config', '--unset', 'core.fsmonitor']);
      await deps.runGit(root, ['fsmonitor--daemon', 'stop']); // non-fatal if not running
    }
  }

  const autoOptimized = new Set<string>();
  async function ensureAutoOptimized(repoRoot: string): Promise<void> {
    if (!repoRoot || autoOptimizeDisabled() || autoOptimized.has(repoRoot)) return;
    autoOptimized.add(repoRoot); // claim now to avoid concurrent re-entry within a process
    try {
      // A sentinel means we already auto-configured this repo once — never
      // re-fight a later manual GitPerfPanel toggle.
      const sentinel = await deps.runGit(repoRoot, ['config', '--get', 'codestudio.gitautooptimized']);
      if (sentinel.code === 0 && sentinel.stdout.trim() === 'true') return;
      await configure(repoRoot, { untrackedCache: true, fsmonitor: true, startDaemon: false });
      await deps.runGit(repoRoot, ['config', 'codestudio.gitautooptimized', 'true']);
    } catch {
      autoOptimized.delete(repoRoot); // transient failure — allow a retry next open
    }
  }

  return {
    async gitOptimizations({ projectId, repoPath }) {
      return read(await deps.resolveCwd(projectId, repoPath));
    },

    async configureGitOptimizations({ projectId, untrackedCache, fsmonitor, repoPath }) {
      const root = await deps.resolveCwd(projectId, repoPath);
      await configure(root, { untrackedCache, fsmonitor });
      return read(root);
    },

    ensureAutoOptimized,
  };
}
