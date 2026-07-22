import { canonicalAbs } from '@mcp/shared/utils/fs-canonical.js';
import type { CodeIndexDB } from '@mcp/store/db.js';
import {
  onAngularWorkspaceMetadataChanged,
} from '@mcp/services/lsp/angular-workspace-index.js';
import type { LspServerManager } from '@mcp/services/lsp/lsp-server-manager.js';
import { ANGULAR_LSP_FAMILY_ID } from './angular-profile-overrides.js';

/** Connect watcher invalidation to scoped Angular route retirement. */
export function wireAngularWorkspaceRetirement(
  db: CodeIndexDB,
  manager: LspServerManager,
): () => void {
  return onAngularWorkspaceMetadataChanged(({ projectRoot, changedPath }) => {
    const project = db.listProjects().find((candidate) =>
      canonicalAbs(candidate.root_path) === projectRoot);
    if (!project) return;
    void manager.retireRoutes(project.id, ANGULAR_LSP_FAMILY_ID, changedPath)
      .catch((error) => console.error(
        `[lsp] Angular route retirement failed for project ${project.id}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      ));
  });
}
