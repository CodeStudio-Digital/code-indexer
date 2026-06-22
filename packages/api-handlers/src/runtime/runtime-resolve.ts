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
import type { CodeIndexDB } from '@mcp/store/db.js';
import { resolveProjectNodeBinDir } from './node-manager.js';
import { resolveBinDir as resolvePhpBinDir } from './php-manager.js';
import { resolveBinDirs as resolvePythonBinDirs } from './python-manager.js';

export interface RuntimeEnv {
  /** Dirs to prepend to PATH, highest priority first. */
  pathPrepend: string[];
  /** Extra env vars (e.g. PHPRC for a managed PHP). */
  extraEnv: Record<string, string>;
}

export interface RuntimeEnvOptions {
  /**
   * Include the project's chosen Node on PATH. Default true (terminal/runner).
   * The agent's shell tools pass `false` on purpose: remapping `node`/`npm` to
   * an old per-project Node could break agent tooling, so the agent inherits
   * the system Node and only gains PHP/Python (and future kinds).
   */
  includeNode?: boolean;
}

export function resolveProjectRuntimeEnv(
  db: CodeIndexDB,
  projectId: number,
  managedDir: string,
  opts: RuntimeEnvOptions = {},
): RuntimeEnv {
  const includeNode = opts.includeNode ?? true;
  const pathPrepend: string[] = [];
  const extraEnv: Record<string, string> = {};

  const project = db.getProject(projectId);
  if (!project) return { pathPrepend, extraEnv };

  // Node — dedicated column (unchanged behaviour); skipped for the agent.
  if (includeNode) {
    const nodeBin = resolveProjectNodeBinDir(db, projectId, managedDir);
    if (nodeBin) pathPrepend.push(nodeBin);
  }

  const rv = parseRuntimeVersions(project.runtime_versions ?? null);

  // PHP — prepend its bin dir; for a managed install (own php.ini), pin PHPRC
  // so php uses our ini regardless of cwd.
  const phpBin = resolvePhpBinDir(rv.php, managedDir);
  if (phpBin) {
    pathPrepend.push(phpBin);
    if (existsSync(join(phpBin, 'php.ini'))) extraEnv.PHPRC = phpBin;
  }

  // Python — bin dir (+ Scripts on Windows).
  for (const dir of resolvePythonBinDirs(rv.python, managedDir)) pathPrepend.push(dir);

  return { pathPrepend, extraEnv };
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
