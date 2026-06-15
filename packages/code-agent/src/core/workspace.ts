/**
 * WorkspaceContext — abstraction over the runtime root the agent operates on.
 *
 * Today every coder session is bound to a `projects` row, so this struct
 * always carries `projectId`. The shape is deliberately permissive so that
 * future "untethered" sessions (sandbox-only, ad-hoc cwd, headless workers)
 * can be supported by relaxing the optionality without touching the call
 * sites that already read `rootPath` / `displayName`.
 *
 * Construction goes through `workspaceFromProject` so the
 * sandbox-binding override (writes land inside the container) is
 * applied in exactly one place.
 */
import { resolve as resolvePath } from 'node:path';

export interface WorkspaceContext {
  /**
   * Absolute, resolved filesystem root the tool layer treats as its cwd.
   * For sandbox-bound sessions this is the container's workdir; otherwise
   * it's the resolved project.root_path.
   */
  rootPath: string;
  /**
   * Human-readable name shown to the model in the system prompt and to
   * external MCP bridges as a project label.
   */
  displayName: string;
  /**
   * Today a sessions's project_id is `NOT NULL`. Carrying it here keeps
   * the repo-map / DB queries straightforward until project-less sessions
   * are wired in (see plan for the next phase).
   */
  projectId: number;
  /** Optional hint — repo-map can short-circuit when the project was never indexed. */
  isIndexed?: boolean;
}

export function workspaceFromProject(
  project: {
    id: number;
    name: string;
    root_path: string;
    last_indexed?: string | null;
    /** Structural-only pass stamp (migration 139) — symbols/FTS usable without LLM. */
    structural_indexed_at?: string | null;
  },
  sandboxBinding?: { workdir: string } | null,
): WorkspaceContext {
  return {
    rootPath: sandboxBinding?.workdir ?? resolvePath(project.root_path),
    displayName: project.name,
    projectId: project.id,
    // "Symbol DB usable" — what grep/find_references/skeleton and the
    // in-session incremental hook actually need. Structural counts.
    isIndexed: project.last_indexed != null || project.structural_indexed_at != null,
  };
}
