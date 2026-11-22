import { lspServersBaseDir } from '@mcp/shared/utils/data-paths.js';
import type { LspServerHandle } from './lsp-server-handle.js';
import type { LspInstanceLifecycle } from './lsp-instance-lifecycle.js';
import type { LspRouteIdentity } from './lsp-route.js';
import type { LspRouteScope, LspRouteState } from './lsp-route-state.js';
import type {
  LspAcquireIntent,
  LspAcquiredServer,
  LspManagerDeps,
  LspManagerEntry,
  LspManagerStatus,
} from './lsp-server-manager-types.js';
import {
  allLspServers,
  isInstalled,
  isLspServerActive,
  needsNestedAngularMarkers,
  overlayServersForLanguage,
  serverById,
  serverForLanguage,
  type LspRuntimeResolution,
  type LspServerDef,
} from './server-registry.js';
import { lspNodeRuntimeStatus } from './lsp-server-node-policy.js';

interface SessionCoordinatorHooks {
  canAcquire: (projectId: number, serverId: string) => boolean;
  spawn: (
    entry: LspManagerEntry,
    baseDir: string,
    projectRoot: string,
    workspaceRoot: string,
    languageId: string,
    runtime?: LspRuntimeResolution,
  ) => Promise<LspServerHandle | null>;
}

/** Framework-aware status and acquisition orchestration behind the public facade. */
export class LspManagerSessionCoordinator {
  constructor(
    private deps: LspManagerDeps,
    private routes: LspRouteState,
    private instances: LspInstanceLifecycle,
    private hooks: SessionCoordinatorHooks,
  ) {}

  private cachedMarkers(projectId: number) {
    const discovery = this.deps.angularWorkspaces;
    return discovery && ((root: string) => discovery.cached(projectId, root));
  }

  private async prepareOverlays(projectId: number, root: string, languages: readonly string[], explicit?: LspServerDef): Promise<void> {
    const discovery = this.deps.angularWorkspaces;
    if (!discovery) return;
    const candidates = explicit ? [explicit] : allLspServers().filter(def =>
      def.role === 'overlay' && (!def.profileId || def.defaultProfile) && def.languages.some(id => languages.includes(id)));
    if (candidates.some(def => needsNestedAngularMarkers(def, root)) && !discovery.cached(projectId, root)) {
      await discovery.load(projectId, root);
    }
  }

  async resolveStatus(projectId: number, languageId: string): Promise<LspManagerStatus> {
    const root = this.deps.resolveRoot(projectId);
    if (root && process.env.MCP_LSP_ENABLED !== '0') await this.prepareOverlays(projectId, root, [languageId]);
    return this.status(projectId, languageId);
  }

  status(projectId: number, languageId: string, identity?: LspRouteIdentity): LspManagerStatus {
    if (process.env.MCP_LSP_ENABLED === '0') return { state: 'disabled' };
    const scope = this.routes.scope(projectId, identity, this.deps.resolveRoot);
    if (!scope) return this.invalidScopeStatus(identity);
    const def = overlayServersForLanguage(languageId, scope.workspaceRoot, this.cachedMarkers(projectId))[0]
      ?? serverForLanguage(languageId);
    this.routes.select(projectId, languageId, def?.id, scope.route);
    if (!def) return { state: 'no-server', ...this.routes.info(scope.route) };
    if (scope.route) {
      this.routes.bind(projectId, def.id, languageId, scope.route, scope.workspaceRoot);
    }
    return this.statusDefinition(projectId, def, scope);
  }

  statusById(
    projectId: number,
    serverId: string,
    languageId: string,
    identity?: LspRouteIdentity,
  ): LspManagerStatus {
    if (process.env.MCP_LSP_ENABLED === '0') return { state: 'disabled' };
    const def = serverById(serverId);
    if (!def) return { state: 'no-server' };
    const scope = this.routes.scope(projectId, identity, this.deps.resolveRoot);
    if (!scope) return this.invalidScopeStatus(identity);
    this.routes.select(projectId, languageId, serverId, scope.route);
    if (scope.route) {
      this.routes.bind(projectId, serverId, languageId, scope.route, scope.workspaceRoot);
    }
    return this.statusDefinition(projectId, def, scope);
  }

  statusByRouteId(projectId: number, routeId: string): LspManagerStatus {
    if (process.env.MCP_LSP_ENABLED === '0') return { state: 'disabled', routeId };
    const binding = this.routes.binding(projectId, routeId);
    if (!binding) return { state: 'no-server', routeId };
    const def = serverById(binding.serverId);
    if (!def) return { state: 'no-server', ...this.routes.info(binding.route) };
    const projectRoot = this.deps.resolveRoot(projectId);
    if (!projectRoot) return { state: 'no-server', ...this.routes.info(binding.route) };
    return this.statusDefinition(projectId, def, {
      projectRoot,
      workspaceRoot: binding.workspaceRoot,
      route: binding.route,
    });
  }

  private invalidScopeStatus(identity?: LspRouteIdentity): LspManagerStatus {
    return identity
      ? { state: 'failed', reason: 'route workspace is outside the project root' }
      : { state: 'no-server' };
  }

  private statusDefinition(
    projectId: number,
    def: LspServerDef,
    scope: LspRouteScope,
  ): LspManagerStatus {
    const routeInfo = this.routes.info(scope.route);
    if (!isLspServerActive(def, scope.workspaceRoot, this.cachedMarkers(projectId))) return { state: 'no-server', ...routeInfo };
    const runtime = def.runtime ? this.deps.resolveRuntime(projectId, def.runtime) : undefined;
    const nodeRuntime = def.serverNodeRange
      ? lspNodeRuntimeStatus(this.deps, projectId, def)
      : undefined;
    if (!isInstalled(this.deps.baseDir ?? lspServersBaseDir(), def)) {
      return { state: 'not-installed', server: def, runtime, nodeRuntime, ...routeInfo };
    }
    if (runtime && !runtime.satisfied) {
      return { state: 'failed', server: def, reason: runtime.reason, runtime, ...routeInfo };
    }
    if (nodeRuntime && !nodeRuntime.satisfied) {
      return {
        state: 'failed', server: def, reason: nodeRuntime.reason,
        runtime, nodeRuntime, ...routeInfo,
      };
    }
    const entry = this.instances.entries.get(this.routes.entryKey(projectId, def.id, scope.route));
    const details = {
      server: def,
      runtime,
      nodeRuntime,
      workspaceMode: entry?.workspaceMode,
      workspaceReason: entry?.workspaceReason,
      ...routeInfo,
    };
    if (entry?.handle?.state === 'ready') return { state: 'ready', ...details };
    if (entry?.blockedReason) return { state: 'failed', reason: entry.blockedReason, ...details };
    if (entry && this.instances.inFailedWindow(entry)) {
      return { state: 'failed', reason: entry.lastExitReason, ...details };
    }
    return entry?.spawning ? { state: 'starting', ...details } : { state: 'idle', ...details };
  }

  acquire(
    projectId: number,
    languageId: string,
    intent: LspAcquireIntent,
    identity?: LspRouteIdentity,
  ): Promise<LspAcquiredServer | null> {
    if (process.env.MCP_LSP_ENABLED === '0') return Promise.resolve(null);
    const def = serverForLanguage(languageId);
    return def
      ? this.acquireDefinition(projectId, def, languageId, intent, identity)
      : Promise.resolve(null);
  }

  acquireById(
    projectId: number,
    serverId: string,
    intent: LspAcquireIntent,
    identity?: LspRouteIdentity,
  ): Promise<LspAcquiredServer | null> {
    if (process.env.MCP_LSP_ENABLED === '0') return Promise.resolve(null);
    const def = serverById(serverId);
    return def
      ? this.acquireDefinition(projectId, def, def.languages[0] ?? 'plaintext', intent, identity)
      : Promise.resolve(null);
  }

  acquireByRouteId(
    projectId: number,
    routeId: string,
    intent: LspAcquireIntent,
  ): Promise<LspAcquiredServer | null> {
    if (process.env.MCP_LSP_ENABLED === '0') return Promise.resolve(null);
    const binding = this.routes.binding(projectId, routeId);
    const def = binding ? serverById(binding.serverId) : undefined;
    return binding && def
      ? this.acquireDefinition(projectId, def, binding.languageId, intent, binding.route)
      : Promise.resolve(null);
  }

  async acquireDefinition(
    projectId: number,
    def: LspServerDef,
    languageId: string,
    intent: LspAcquireIntent,
    identity?: LspRouteIdentity,
  ): Promise<LspAcquiredServer | null> {
    if (!this.hooks.canAcquire(projectId, def.id)) return null;
    const scope = this.routes.scope(projectId, identity, this.deps.resolveRoot);
    if (!scope) return null;
    const { projectRoot, workspaceRoot, route } = scope;
    if (route && this.routes.isRouteRetiring(projectId, route.routeId)) return null;
    if (route) this.routes.bind(projectId, def.id, languageId, route, workspaceRoot);
    if (this.deps.angularWorkspaces) {
      const epoch = route && this.routes.routeEpoch(projectId, route.routeId);
      if (!route) await this.prepareOverlays(projectId, projectRoot, def.languages);
      if (def.launchKind === 'angular') await this.prepareOverlays(projectId, workspaceRoot, [], def);
      if (!this.hooks.canAcquire(projectId, def.id)) return null;
      if (route && epoch !== this.routes.routeEpoch(projectId, route.routeId)) return null;
    }
    for (const routedLanguageId of def.languages) {
      const effective = route
        ? def
        : overlayServersForLanguage(routedLanguageId, projectRoot, this.cachedMarkers(projectId))[0]
          ?? serverForLanguage(routedLanguageId);
      this.routes.select(projectId, routedLanguageId, effective?.id, route);
    }
    this.instances.activateProject(projectId);
    const key = this.routes.entryKey(projectId, def.id, route);
    let entry = this.instances.entries.get(key);
    if (entry?.handle?.state === 'ready') {
      this.instances.touch(entry);
      return { handle: entry.handle, def, root: workspaceRoot, ...this.routes.info(route) };
    }
    if (!entry?.spawning && def.activation === 'interactive'
      && intent !== 'interactive' && intent !== 'manual') return null;

    const baseDir = this.deps.baseDir ?? lspServersBaseDir();
    if (!isInstalled(baseDir, def) || !isLspServerActive(def, workspaceRoot, this.cachedMarkers(projectId))) return null;
    const runtime = def.runtime ? this.deps.resolveRuntime(projectId, def.runtime) : undefined;
    if (runtime && !runtime.satisfied) return null;
    if (!entry) {
      entry = this.createEntry(projectId, def, scope, languageId);
      this.instances.entries.set(key, entry);
    }
    entry.blockedReason = undefined;
    if (this.instances.inFailedWindow(entry)) return null;
    if (!entry.spawning) {
      entry.spawning = this.hooks.spawn(
        entry,
        baseDir,
        projectRoot,
        workspaceRoot,
        languageId,
        runtime,
      );
    }
    const pending = entry.spawning;
    const handle = await pending;
    if (!handle && entry.spawning === pending) entry.spawning = null;
    return handle ? { handle, def, root: workspaceRoot, ...this.routes.info(route) } : null;
  }

  private createEntry(
    projectId: number,
    def: LspServerDef,
    scope: LspRouteScope,
    languageId: string,
  ): LspManagerEntry {
    return {
      def,
      projectId,
      handle: null,
      spawning: null,
      crashTimes: [],
      idleTimer: null,
      route: scope.route,
      routeEpoch: scope.route
        ? this.routes.routeEpoch(projectId, scope.route.routeId)
        : undefined,
      workspaceRoot: scope.workspaceRoot,
      languageId,
    };
  }
}
