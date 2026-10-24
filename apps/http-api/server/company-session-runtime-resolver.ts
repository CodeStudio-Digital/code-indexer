import type { FsSessionStore } from '@mcp/session-storage/fs-store/index.js';
import { CompanySessionFiles } from '@mcp/company/services/CompanySessionFiles.js';
import type { CompanySessionId } from '@mcp/session-storage';
import type { CompanySessionRuntimeContext } from '../sse/WorkerOrchestratorPool.js';

export interface CompanyRuntimeProject {
  id: number;
  root_path: string;
  is_synthetic?: number | boolean;
}

/**
 * Build the filesystem-authoritative context a company worker needs to boot.
 *
 * Company bundles may live in the global session root even though their
 * primary project is a normal indexed project. Resolve the bundle through the
 * session catalog and the project root through the live project catalog; do
 * not reconstruct either path from the company id.
 */
export function createCompanySessionRuntimeResolver(
  sessionStore: FsSessionStore,
  getProject: (projectId: number) => CompanyRuntimeProject | null | undefined,
): (sessionId: CompanySessionId) => Promise<CompanySessionRuntimeContext> {
  return async (sessionId) => {
    await sessionStore.ensureCatalog();
    const files = new CompanySessionFiles({
      companySessionId: sessionId,
      sessionStore,
    });
    const session = files.getSession();
    const primaryProjectId = session.project_ids[0];
    if (primaryProjectId == null) {
      throw new Error(`Filesystem Company session ${sessionId} has no linked projects`);
    }
    const project = getProject(primaryProjectId);
    if (!project || project.is_synthetic || !project.root_path.trim()) {
      throw new Error(
        `Primary project ${primaryProjectId} is unavailable for filesystem Company session ${sessionId}`,
      );
    }
    return {
      sessionId: files.companySessionId,
      bundlePath: files.location.bundle_path,
      projectId: primaryProjectId,
      projectRoot: project.root_path,
    };
  };
}
