import type { DocChange } from '@mcp/api-bus';
import type { CodeIndexDB } from '@mcp/store/db.js';
import { mcpDataDir } from '@mcp/shared/utils/config.js';
import { relToAbsCanonical as relToAbs } from '@mcp/shared/utils/fs-canonical.js';
import { parseLanguageLevels } from '@mcp/shared/utils/language-levels.js';
import { parseRuntimeVersions } from '@mcp/shared/utils/runtime-versions.js';
import { mapLspConfigSection, languageLevelForServer } from '@mcp/services/lsp/lsp-config-map.js';
import { defineLspRoute } from '@mcp/services/lsp/lsp-route.js';
import type { LspServerHandle } from '@mcp/services/lsp/lsp-server-handle.js';
import {
  getLspServerManager,
  type LspServerManager,
} from '@mcp/services/lsp/lsp-server-manager.js';
import {
  serverById,
  serverForLanguage,
  type LspServerDef,
} from '@mcp/services/lsp/server-registry.js';
import { resolveProjectNodeBinDir } from '../runtime/node-manager.js';
import { loadedExtensionsForRuntimeId } from '../runtime/php-manager.js';
import { angularProfileTarget, projectAngularDiscovery } from './angular-profile-routing.js';
import { wireAngularWorkspaceRetirement } from './angular-workspace-retirement.js';
import { clearDiagnosticsSource } from './diagnostics-hub.js';
import {
  createServerDiagnosticsBatcher,
  type ServerDiagnosticsBatcher,
} from './diagnostics-batcher.js';
import { docsForProject, getDoc, onDocEvent, type StoredDoc } from './document-store.js';
import { detectLanguageLevel } from './language-level-detect.js';
import { resolveLspRuntime } from './lsp-runtime.js';
import { serverInfo } from './server-backend-mappers.js';
import { publishServerStatus } from './server-status-hub.js';

let wired = false;
/** Module singleton (dual handler factories) — resolves roots once per flush. */
let diagnosticsBatcher: ServerDiagnosticsBatcher | null = null;

function projectLanguageLevels(db: CodeIndexDB, projectId: number) {
  if (process.env.MCP_LSP_LANGUAGE_LEVEL === '0') return {};
  const project = db.getProject(projectId);
  const levels = parseLanguageLevels(project?.language_levels ?? null);
  if (!project?.root_path) return levels;
  for (const language of ['php', 'python'] as const) {
    if (!levels[language]) {
      const detected = detectLanguageLevel(project.root_path, language);
      if (detected) levels[language] = detected;
    }
  }
  return levels;
}

function projectPhpExtensions(db: CodeIndexDB, projectId: number): string[] {
  const runtimeId = parseRuntimeVersions(db.getProject(projectId)?.runtime_versions ?? null).php;
  return loadedExtensionsForRuntimeId(runtimeId, mcpDataDir());
}

function wireDocumentEvents(db: CodeIndexDB, manager: LspServerManager): void {
  wireAngularWorkspaceRetirement(db, manager);
  const overlayRoutes = new WeakMap<StoredDoc, string>();
  const resolving = new WeakSet<StoredDoc>();
  onDocEvent(({ projectId, file, doc, kind, changes }) => {
    const root = db.getProject(projectId)?.root_path;
    if (!root) return;
    const primary = serverForLanguage(doc.languageId);
    const abs = relToAbs(root, file);
    const forward = (handle: LspServerHandle, def: LspServerDef) => {
      if (!def.languages.includes(doc.languageId)) return;
      if (kind === 'change') {
        handle.didChange(abs, doc.version, doc.content, (changes ?? []).map((change: DocChange) => ({
          start: change.range.start,
          end: change.range.end,
          text: change.text,
        })));
      } else if (kind === 'close') {
        handle.didClose(abs);
      }
    };
    if (kind === 'open') {
      if (primary) void manager.acquireById(projectId, primary.id, 'open').then(acquired => {
        if (acquired?.handle.state === 'ready' && getDoc(projectId, file) === doc) {
          acquired.handle.ensureOpen(abs, doc.languageId, doc.version, doc.content);
        }
      }).catch(() => undefined);
    } else {
      const bound = overlayRoutes.get(doc);
      manager.forEachReady(projectId, (handle, def, _workspaceRoot, routeId) => {
        if (!routeId || routeId === bound) forward(handle, def);
      });
    }

    if (kind === 'close' || resolving.has(doc)) return;
    resolving.add(doc);
    void angularProfileTarget(db, projectId, root, file, doc.languageId).then(async target => {
      if (getDoc(projectId, file) !== doc) return;
      const next = target?.identity && defineLspRoute(target.identity).routeId;
      const previous = overlayRoutes.get(doc);
      if (previous === next) return;
      if (previous) {
        manager.forEachReady(projectId, handle => handle.didClose(abs), previous);
        overlayRoutes.delete(doc);
      }
      if (!next || !target) return;
      overlayRoutes.set(doc, next);
      const acquired = await manager.acquireById(projectId, target.def.id, 'open', target.identity);
      if (acquired?.handle.state === 'ready' && getDoc(projectId, file) === doc) {
        // Edits received during discovery are already in this live buffer.
        acquired.handle.ensureOpen(abs, doc.languageId, doc.version, doc.content);
      }
    }).catch(() => undefined).finally(() => resolving.delete(doc));
  });
}

/** Configure and return the process-wide LSP manager. */
export function ensureLspManager(db: CodeIndexDB): LspServerManager {
  const levelsFor = (projectId: number) => projectLanguageLevels(db, projectId);
  const manager = getLspServerManager({
    angularWorkspaces: projectAngularDiscovery(db),
    resolveNodeBin: (projectId) => {
      try {
        return resolveProjectNodeBinDir(db, projectId, mcpDataDir());
      } catch {
        return null;
      }
    },
    resolveRoot: (projectId) => db.getProject(projectId)?.root_path ?? null,
    listProjectRoots: () => db.listProjects().map((project) => project.root_path),
    resolveRuntime: (projectId, requirement) => resolveLspRuntime(db, projectId, requirement),
    resolveLanguageLevel: (projectId, serverId) => languageLevelForServer(serverId, levelsFor(projectId)),
    resolveLspConfig: (projectId, serverId, section) => mapLspConfigSection(
      serverId,
      section,
      levelsFor(projectId),
      serverId === 'intelephense'
        ? { phpExtensions: projectPhpExtensions(db, projectId) }
        : {},
    ),
    docsForReplay: (projectId, languages) => docsForProject(projectId)
      .filter(({ doc }) => languages.includes(doc.languageId))
      .map(({ file, doc }) => ({
        file,
        languageId: doc.languageId,
        version: doc.version,
        content: doc.content,
      })),
    onDiagnostics: (projectId, absPath, serverId, diagnostics, routeId) => {
      diagnosticsBatcher ??= createServerDiagnosticsBatcher({
        resolveRoot: (id) => db.getProject(id)?.root_path ?? null,
        includeFile: (id, file, originServerId) => originServerId !== 'omnisharp'
          || getDoc(id, file)?.languageId === 'csharp',
      });
      diagnosticsBatcher.enqueue(projectId, absPath, serverId, diagnostics, routeId);
    },
    onStateChange: (projectId, serverId, state, reason, routeId) => {
      const def = serverById(serverId);
      if (!def) return;
      const info = serverInfo(def);
      for (const languageId of def.languages) {
        const selected = routeId
          ? getLspServerManager()?.statusByRouteId(projectId, routeId).server
          : getLspServerManager()?.status(projectId, languageId).server;
        if (selected?.id === serverId) {
          publishServerStatus(projectId, { languageId, state, server: info, reason });
        }
      }
    },
    onRoutingChange: (projectId, languageId, routeId) => {
      const current = getLspServerManager();
      if (!current) return;
      const status = routeId
        ? current.statusByRouteId(projectId, routeId)
        : current.status(projectId, languageId);
      publishServerStatus(projectId, {
        languageId,
        state: status.state,
        server: status.server ? serverInfo(status.server) : undefined,
        reason: status.reason,
      });
    },
    onRouteRetired: (projectId, serverId, routeId) => {
      diagnosticsBatcher?.discardRoute(projectId, serverId, routeId);
      clearDiagnosticsSource(projectId, `lsp:${serverId}:${routeId}`);
    },
    log: (message) => console.error(message),
  })!;

  if (!wired) {
    wired = true;
    wireDocumentEvents(db, manager);
  }
  return manager;
}
