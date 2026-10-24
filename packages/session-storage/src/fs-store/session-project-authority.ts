import type { ProjectId } from '@mcp/session-storage';
import type {
  FsCoderSession,
  FsLinkedProject,
  FsProjectInfo,
} from './types.js';

export type CurrentProjectInfoResolver = (
  projectId: ProjectId,
) => FsProjectInfo | null | undefined;

export interface SessionProjectAuthority {
  primary: FsLinkedProject;
  projects: readonly FsLinkedProject[];
}

/**
 * Rebuild the roots a session may use from the current essential project
 * catalog. The bundle contributes stable link identity and presentation
 * metadata only; a root_path persisted in session.json is never authority.
 *
 * Global sessions remain listable when projects disappear. At execution time
 * the persisted primary is preferred when it is still registered, otherwise
 * the first remaining linked project becomes primary. No remaining project
 * means no runtime authority.
 */
export function resolveSessionProjectAuthority(
  session: Pick<
    FsCoderSession,
    'is_global' | 'linked_projects' | 'project_id'
  >,
  resolveCurrentProject: CurrentProjectInfoResolver,
): SessionProjectAuthority | null {
  const sessionLinks = Array.isArray(session.linked_projects)
    ? session.linked_projects
    : [];
  const ownerLink = session.project_id == null
    ? undefined
    : sessionLinks.find(
        (project) => project.project_id === session.project_id,
      );
  const linked = session.is_global
    ? sessionLinks
    : session.project_id == null
      ? []
      : [ownerLink ?? {
              project_id: session.project_id,
              name: String(session.project_id),
              root_path: '',
              is_primary: true,
              label: null,
            }];

  const seen = new Set<ProjectId>();
  const available = linked.flatMap((persisted) => {
    if (seen.has(persisted.project_id)) return [];
    seen.add(persisted.project_id);
    const current = resolveCurrentProject(persisted.project_id);
    if (!current || current.root_path.trim().length === 0) return [];
    return [{
      project_id: persisted.project_id,
      name: current.name,
      root_path: current.root_path,
      is_primary: false,
      label: persisted.label,
    } satisfies FsLinkedProject];
  });
  if (available.length === 0) return null;

  const persistedPrimaryId =
    linked.find((project) => project.is_primary)?.project_id
    ?? session.project_id;
  const primary =
    available.find((project) => project.project_id === persistedPrimaryId)
    ?? available[0]!;
  const projects = available.map((project) => ({
    ...project,
    is_primary: project.project_id === primary.project_id,
  }));

  return {
    primary: projects.find(
      (project) => project.project_id === primary.project_id,
    )!,
    projects,
  };
}

export function requireSessionProjectAuthority(
  session: Pick<
    FsCoderSession,
    'id' | 'is_global' | 'linked_projects' | 'project_id'
  >,
  resolveCurrentProject: CurrentProjectInfoResolver,
): SessionProjectAuthority {
  const authority = resolveSessionProjectAuthority(
    session,
    resolveCurrentProject,
  );
  if (!authority) {
    throw new Error(
      `Session ${session.id} has no available project in the current catalog`,
    );
  }
  return authority;
}
