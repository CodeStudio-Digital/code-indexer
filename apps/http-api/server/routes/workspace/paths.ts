import type { CoreDeps } from '../../deps.js';
import { resolveSafe } from '@mcp/code-agent/tools/paths.js';

export interface ResolvedProjectPath {
  root: string;
  abs: string;
}

/**
 * Look up a project's `root_path` and resolve a relative path safely against
 * it. Returns `null` when the project is missing or the path escapes the
 * root (prevents traversal). Shared by every workspace route so the guard
 * is enforced in exactly one place (DRY).
 */
export function resolveProjectPath(
  deps: Pick<CoreDeps, 'db'>,
  projectId: number,
  relPath: string,
): ResolvedProjectPath | null {
  const project = deps.db.getProject(projectId);
  if (!project?.root_path) return null;
  const abs = resolveSafe(relPath || '.', project.root_path);
  if (!abs) return null;
  return { root: project.root_path, abs };
}
