import { realpath, stat } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import type { HttpRouter } from '@mcp/shared/http/router.js';
import { ApiError } from '@mcp/api-bus';
import { normalizeSemanticFolders, projectSemanticFolders } from '@mcp/shared/utils/semantic-folders.js';
import { codeNamespace } from '@mcp/shared/vector-namespace.js';
import type { ServerDeps } from '../deps.js';
import { isSqliteBusyError } from '../semantic-coordinator-shared.js';
import { notFound, parseIdParam, parseJsonBody } from './_helpers.js';
import { mapApiError } from './project-route-errors.js';

function parseFolders(value: unknown): string[] {
  try {
    return normalizeSemanticFolders(value);
  } catch (error) {
    throw new ApiError('invalid_input', 400, (error as Error).message);
  }
}

async function checkFolders(rootPath: string, folders: readonly string[]): Promise<void> {
  const root = await realpath(rootPath);
  for (const folder of folders) {
    if (folder === '.') continue;
    const absolute = await realpath(resolve(root, folder)).catch(() => null);
    const pathFromRoot = absolute ? relative(root, absolute) : '..';
    if (!absolute || !pathFromRoot || isAbsolute(pathFromRoot) || pathFromRoot === '..'
      || pathFromRoot.startsWith('..' + sep) || !(await stat(absolute)).isDirectory()) {
      throw new ApiError('invalid_input', 400, `Choose a folder inside this project: ${folder}`);
    }
  }
}

export function mountProjectSemanticFoldersRoutes(app: HttpRouter, deps: ServerDeps): void {
  const path = '/api/projects/:id/semantic/folders';
  app.get(path, (c) => {
    try {
      const projectId = parseIdParam(c);
      const project = deps.db.getProjectCatalogEntry(projectId);
      if (!project) return notFound(c);
      const saved = projectSemanticFolders(project);
      const folders = c.req.queries('folder');
      const preview = folders ? parseFolders(folders) : saved;
      const state = deps.semanticStore.listNamespaceGenerations({ namespace: codeNamespace(projectId) })[0];
      const generationId = state?.building_generation_id ?? state?.active_generation_id;
      const profile = deps.semanticStore.getProfile('code')?.embedding_target;
      const desired = deps.semanticStore.getProjectTargets?.(projectId)?.embedding_target ?? profile;
      const target = generationId ? deps.semanticStore.getGeneration(generationId)?.embedding_target : desired;
      return c.json({
        folders: saved,
        files: deps.db.countFilesInFolders(projectId, preview),
        remote: target?.kind === 'provider',
        enabled: !!profile && profile.kind !== 'disabled',
      });
    } catch (error) {
      return mapApiError(c, error);
    }
  });

  app.put(path, async (c) => {
    try {
      const projectId = parseIdParam(c);
      const project = deps.db.getProjectCatalogEntry(projectId);
      if (!project) return notFound(c);
      if (project.is_synthetic || project.worktree_parent_id) {
        throw new ApiError('invalid_input', 400, 'Choose semantic folders from the owning project');
      }
      const input = await parseJsonBody<{ folders?: unknown }>(c);
      const folders = parseFolders(input.folders);
      if (!folders.length) throw new ApiError('invalid_input', 400, 'Choose at least one project folder');
      await checkFolders(project.root_path, folders);
      if (deps.db.getProjectCatalogEntry(projectId)?.root_path !== project.root_path) {
        throw new ApiError('conflict', 409, 'Project root changed');
      }
      deps.semanticCoordinator.setCodeProjectFolders(projectId, folders);
      deps.hybridSearch?.invalidateCache?.();
      return c.json({ folders, files: deps.db.countFilesInFolders(projectId, folders) }, 202);
    } catch (error) {
      if (isSqliteBusyError(error)) return c.json({ error: 'The index is busy. Try saving the folders again.' }, 409);
      return mapApiError(c, error);
    }
  });
}
