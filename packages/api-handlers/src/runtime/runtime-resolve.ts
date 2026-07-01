/**
 * Aggregate a project's chosen runtimes (Node + PHP + Python) into the PATH
 * prepend list and extra env the terminal/runner inject at spawn time. One
 * call replaces the old single `resolveProjectNodeBinDir` usage at the two
 * spawn callsites; Node keeps its dedicated column, PHP/Python live in the
 * `runtime_versions` JSON column.
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { ensureDataDir } from '@mcp/shared/utils/config.js';
import { parseRuntimeVersions } from '@mcp/shared/utils/runtime-versions.js';
import { parseWslRuntimeVersions } from '@mcp/shared/utils/wsl-runtime-versions.js';
import type { RuntimeKind, RuntimeTarget } from '@mcp/api-bus';
import type { CodeIndexDB } from '@mcp/store/db.js';
import { resolveProjectNodeBinDir } from './node-manager.js';
import { resolveBinDir as resolvePhpBinDir } from './php-manager.js';
import { resolveBinDirs as resolvePythonBinDirs } from './python-manager.js';
import { wslBinDirForId } from './wsl-paths.js';

export interface RuntimeEnv {
  /**
   * Dirs to prepend to the WINDOWS-style PATH (delim `;`), highest priority
   * first. Used for a `host` target. Empty for a `wsl` target.
   */
  pathPrepend: string[];
  /** Extra env vars for a `host` target (e.g. PHPRC for a managed PHP). */
  extraEnv: Record<string, string>;
  /**
   * Dirs to prepend to the distro's POSIX PATH (delim `:`), highest priority
   * first — these are paths INSIDE a WSL distro (e.g. `$HOME/.mcp/...`), woven
   * into the `bash -lc 'export PATH="…:$PATH"; <cmd>'` invocation. Empty for a
   * `host` target.
   */
  posixPathPrepend: string[];
  /** Extra env exported inside the distro for a `wsl` target. */
  posixExtraEnv: Record<string, string>;
}

/**
 * Merge per-project runtime envs (caller passes them PRIMARY FIRST): dedupe
 * PATH dirs keeping the first occurrence (so the primary's bins win), and
 * first-writer-wins for `extraEnv` — a clash means two union projects picked
 * different versions of the same runtime, and only one can be active. Pure, so
 * the union behaviour is testable without fs/sqlite.
 */
function pushUnique(into: string[], dirs: string[]): void {
  for (const dir of dirs) if (!into.includes(dir)) into.push(dir);
}

function mergeFirstWins(into: Record<string, string>, from: Record<string, string>, label: string): void {
  for (const [k, v] of Object.entries(from)) {
    if (k in into) {
      if (into[k] !== v) console.debug(`[runtime] union ${label} ${k}: keeping "${into[k]}", ignoring "${v}"`);
      continue;
    }
    into[k] = v;
  }
}

export function mergeRuntimeEnvs(envs: RuntimeEnv[]): RuntimeEnv {
  const merged = emptyRuntimeEnv();
  for (const env of envs) {
    pushUnique(merged.pathPrepend, env.pathPrepend);
    pushUnique(merged.posixPathPrepend, env.posixPathPrepend);
    mergeFirstWins(merged.extraEnv, env.extraEnv, 'env');
    mergeFirstWins(merged.posixExtraEnv, env.posixExtraEnv, 'posixEnv');
  }
  return merged;
}

function emptyRuntimeEnv(): RuntimeEnv {
  return { pathPrepend: [], extraEnv: {}, posixPathPrepend: [], posixExtraEnv: {} };
}

export interface RuntimeEnvOptions {
  /**
   * Include the project's chosen Node on PATH. Default true (terminal/runner).
   * The agent's shell tools pass `false` on purpose: remapping `node`/`npm` to
   * an old per-project Node could break agent tooling, so the agent inherits
   * the system Node and only gains PHP/Python (and future kinds).
   */
  includeNode?: boolean;
  /**
   * Execution target the spawn is going to (default `host`). A `wsl` target
   * resolves the distro's MCP-managed runtimes into `posixPathPrepend` and
   * produces NO Windows `pathPrepend` (those are useless inside Linux).
   */
  target?: RuntimeTarget;
}

export function resolveProjectRuntimeEnv(
  db: CodeIndexDB,
  projectId: number,
  managedDir: string,
  opts: RuntimeEnvOptions = {},
): RuntimeEnv {
  const includeNode = opts.includeNode ?? true;
  const target = opts.target ?? { kind: 'host' };
  const out = emptyRuntimeEnv();

  const project = db.getProject(projectId);
  if (!project) return out;

  // Global (multi-project) session: the session runs over a SYNTHETIC union
  // project (mig 155) whose own runtime selection is empty. Resolve the
  // runtimes of every REAL constituent and merge them, primary first so its
  // bins take PATH precedence. Inert for ordinary projects (no `is_synthetic`).
  if (project.is_synthetic) {
    return mergeRuntimeEnvs(
      db.listUnionProjectIds(projectId).map((link) =>
        resolveProjectRuntimeEnv(db, link.project_id, managedDir, opts),
      ),
    );
  }

  // WSL target: managed Linux runtimes live INSIDE the distro at a
  // deterministic path — prepend them on the POSIX PATH. No Windows injection.
  if (target.kind === 'wsl') {
    const wv = parseWslRuntimeVersions(project.wsl_runtime_versions ?? null)[target.distro] ?? {};
    const kinds: RuntimeKind[] = includeNode ? ['node', 'php', 'python'] : ['php', 'python'];
    for (const k of kinds) {
      const bin = wslBinDirForId(k, wv[k]);
      if (bin) out.posixPathPrepend.push(bin);
    }
    return out;
  }

  // Host target — Windows/macOS/Linux native (and Git Bash, which uses the
  // Windows runtimes via MSYS). Prepend the managed bin dirs to the Win PATH.
  if (includeNode) {
    const nodeBin = resolveProjectNodeBinDir(db, projectId, managedDir);
    if (nodeBin) out.pathPrepend.push(nodeBin);
  }

  const rv = parseRuntimeVersions(project.runtime_versions ?? null);

  // PHP — prepend its bin dir; for a managed install (own php.ini), pin PHPRC
  // so php uses our ini regardless of cwd.
  const phpBin = resolvePhpBinDir(rv.php, managedDir);
  if (phpBin) {
    out.pathPrepend.push(phpBin);
    if (existsSync(join(phpBin, 'php.ini'))) out.extraEnv.PHPRC = phpBin;
  }

  // Python — bin dir (+ Scripts on Windows).
  for (const dir of resolvePythonBinDirs(rv.python, managedDir)) out.pathPrepend.push(dir);

  return out;
}

/**
 * Resolver for the LLM agent's shell tools: the project's PHP/Python (and any
 * future runtimes) WITHOUT Node — selecting an old per-project Node for the
 * agent's own commands is risky, so the agent keeps the system Node. Matches
 * the `(db, projectId) => RuntimeEnv` shape `runCoder` expects; the host passes
 * this so code-agent never imports api-handlers (no dep cycle).
 */
export function resolveAgentRuntimeEnv(db: CodeIndexDB, projectId: number): RuntimeEnv {
  return resolveProjectRuntimeEnv(db, projectId, ensureDataDir(), { includeNode: false });
}
