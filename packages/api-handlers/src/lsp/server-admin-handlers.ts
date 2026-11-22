import { resolve } from 'node:path';
import { ApiError, type LspApi } from '@mcp/api-bus';
import { languageIdForPath } from '@mcp/shared/utils/language-id.js';
import { defaultLevelFor, parseLanguageLevels, writeLanguageLevel } from '@mcp/shared/utils/language-levels.js';
import { installServer, listServers, removeServer } from '@mcp/services/lsp/server-installer.js';
import { serverById, serverForLanguage } from '@mcp/services/lsp/server-registry.js';
import { angularProfileTarget } from './angular-profile-routing.js';
import {
  ANGULAR_LSP_FAMILY_ID,
  listAngularProfileOverrides,
  writeAngularProfileOverride,
} from './angular-profile-overrides.js';
import { documentSyncCounters } from './document-store.js';
import type { LspHandlerContext } from './handler-context.js';
import { detectLanguageLevel } from './language-level-detect.js';
import { invalidateLspRuntimeCache } from './lsp-runtime.js';
import { restartInstalledServerInstances } from './restart-installed-server.js';
import { validateRestartServerTarget } from './restart-server-validation.js';
import { serverStatusFor } from './server-backend.js';
import { subscribeServerStatus } from './server-status-hub.js';

type ServerAdminHandlers = Pick<
  LspApi,
  | 'serverStatus'
  | 'serverStatusStream'
  | 'listServers'
  | 'instances'
  | 'installServerStream'
  | 'removeServer'
  | 'restartServer'
  | 'angularProfileOverrides'
  | 'setAngularProfileOverride'
  | 'setLanguageLevel'
  | 'languageLevels'
>;

function restartFailed(): ApiError {
  return new ApiError('lsp_restart_failed', 503, 'language server failed to restart');
}

export function createServerAdminHandlers(context: LspHandlerContext): ServerAdminHandlers {
  const { db, lspManager, requireProjectRoot } = context;

  return {
    async serverStatus({ projectId, languageId, file }) {
      requireProjectRoot(projectId);
      return serverStatusFor(db, projectId, languageId, file);
    },

    serverStatusStream({ projectId }) {
      requireProjectRoot(projectId);
      return subscribeServerStatus(projectId);
    },

    async listServers() {
      return listServers();
    },

    async instances() {
      const counters = documentSyncCounters();
      return lspManager.listInstances().map((instance) => ({ ...instance, counters }));
    },

    installServerStream({ serverId }) {
      return (async function* installAndRestart() {
        for await (const frame of installServer(serverId)) {
          if (frame.phase === 'done') {
            invalidateLspRuntimeCache();
            await restartInstalledServerInstances(lspManager, serverId);
          }
          yield frame;
        }
      })();
    },

    async removeServer({ serverId }) {
      return { ok: await lspManager.uninstallServer(serverId, () => removeServer(serverId)) };
    },

    async restartServer({ projectId, serverId, routeId, file }) {
      const projectRoot = requireProjectRoot(projectId);
      const boundRoute = typeof routeId === 'string' && routeId
        ? lspManager.routeTarget(projectId, routeId)
        : null;
      const targetFile = typeof file === 'string' && file ? file : undefined;
      const languageId = targetFile ? languageIdForPath(targetFile) : boundRoute?.languageId;
      const angular = targetFile && languageId
        ? await angularProfileTarget(db, projectId, projectRoot, targetFile, languageId)
        : undefined;
      const target = validateRestartServerTarget({
        projectRoot,
        serverId,
        routeId,
        file,
        languageId,
        def: serverById(serverId),
        boundRoute,
        angular,
      });

      invalidateLspRuntimeCache();
      if (target.kind === 'route') {
        const restarted = await lspManager.restartRoute(projectId, target.routeId);
        if (!restarted) {
          if (!lspManager.routeTarget(projectId, target.routeId)) {
            throw new ApiError('not_found', 404, 'LSP route is stale or unknown');
          }
          throw restartFailed();
        }
      } else if (!await lspManager.restart(projectId, serverId, target.identity)) {
        throw restartFailed();
      }
      return { ok: true };
    },

    async angularProfileOverrides({ projectId }) {
      requireProjectRoot(projectId);
      return listAngularProfileOverrides(db, projectId);
    },

    async setAngularProfileOverride({ projectId, workspacePath, profileId }) {
      const projectRoot = requireProjectRoot(projectId);
      writeAngularProfileOverride(db, projectId, projectRoot, workspacePath, profileId);
      await lspManager.retireRoutes(
        projectId,
        ANGULAR_LSP_FAMILY_ID,
        resolve(projectRoot, workspacePath, 'package.json'),
      );
      return { ok: true };
    },

    async setLanguageLevel({ projectId, languageId, level }) {
      requireProjectRoot(projectId);
      const project = db.getProject(projectId)!;
      db.updateProject(projectId, {
        language_levels: writeLanguageLevel(project.language_levels, languageId, level),
      });
      const def = serverForLanguage(languageId);
      // Persisting a language level must also succeed before its optional LSP
      // is installed; restart only applies it immediately when available.
      if (def) await lspManager.restart(projectId, def.id);
      return { ok: true };
    },

    async languageLevels({ projectId }) {
      const project = db.getProject(projectId);
      if (!project) throw new ApiError('not_found', 404, 'project not found');
      const explicit = parseLanguageLevels(project.language_levels);
      const compute = (languageId: 'php' | 'python') => {
        const configured = explicit[languageId];
        const detected = configured ? undefined : detectLanguageLevel(project.root_path, languageId);
        const level = configured ?? detected ?? defaultLevelFor(languageId);
        const source: 'explicit' | 'detected' | 'default' = configured
          ? 'explicit'
          : detected
            ? 'detected'
            : 'default';
        return { level, source };
      };
      return { php: compute('php'), python: compute('python') };
    },
  };
}
