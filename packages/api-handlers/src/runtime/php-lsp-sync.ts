import type { InstallProgress } from '@mcp/api-bus';
import type { Project } from '@mcp/shared/types.js';
import { parseRuntimeVersions } from '@mcp/shared/utils/runtime-versions.js';

interface ProjectCatalog {
  listProjects(): Project[];
}

interface LspRefreshManager {
  status(projectId: number, languageId: string): { state: string };
  restart(projectId: number, serverId: string): Promise<void | boolean>;
}

/** Projects whose selected host runtime is exactly this managed PHP build. */
export function projectsUsingManagedPhpVersion(projects: readonly Project[], version: string): number[] {
  const runtimeId = `managed:${version}`;
  return projects
    .filter((project) => parseRuntimeVersions(project.runtime_versions).php === runtimeId)
    .map((project) => project.id);
}

/** Restart only live/starting Intelephense instances affected by a global ini change. */
export async function refreshRunningIntelephense(
  projects: ProjectCatalog,
  manager: LspRefreshManager | null | undefined,
  version: string,
): Promise<void> {
  if (!manager) return;
  const projectIds = projectsUsingManagedPhpVersion(projects.listProjects(), version);
  await Promise.allSettled(projectIds.map(async (projectId) => {
    const state = manager.status(projectId, 'php').state;
    if (state === 'ready' || state === 'starting') {
      await manager.restart(projectId, 'intelephense');
    }
  }));
}

/** Refresh after, and only after, an extension install emitted its done frame. */
export async function* refreshAfterSuccessfulPhpExtensionInstall(
  progress: AsyncIterable<InstallProgress>,
  refresh: () => Promise<void>,
): AsyncGenerator<InstallProgress> {
  let completed = false;
  for await (const event of progress) {
    if (event.phase === 'done') completed = true;
    yield event;
  }
  if (completed) await refresh();
}
