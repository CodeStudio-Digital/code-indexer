/** Public orchestration facade for lazy, routed LSP server instances. */
import type { LspServerHandle } from './lsp-server-handle.js';
import { LspInstanceLifecycle } from './lsp-instance-lifecycle.js';
import { LspManagerSessionCoordinator } from './lsp-manager-session-coordinator.js';
import { resolveLspServerNode } from './lsp-server-node-policy.js';
import {
  defineLspRoute,
  lspRouteAffectedByPath,
  type LspRouteIdentity,
} from './lsp-route.js';
import { LspRouteState } from './lsp-route-state.js';
import type {
  LspAcquireIntent,
  LspAcquiredServer,
  LspBoundRouteTarget,
  LspManagerDeps,
  LspManagerEntry,
  LspManagerInstance,
  LspManagerStatus,
  LspRouteSelection,
} from './lsp-server-manager-types.js';
import {
  serverById,
  type LspRuntimeResolution,
  type LspServerDef,
} from './server-registry.js';

export {
  isSupportedLspNodeVersion,
  lspNodeRuntimeStatus,
  satisfiesLspNodeRange,
} from './lsp-server-node-policy.js';
export type { LspRouteIdentity } from './lsp-route.js';
export type {
  LspAcquireIntent,
  LspAcquiredServer,
  LspInstanceState,
  LspManagerDeps,
  LspManagerStatus,
  LspNodeRuntimeStatus,
} from './lsp-server-manager-types.js';

export class LspServerManager {
  private uninstallingServerIds = new Set<string>();
  private stoppingProjectIds = new Set<number>();
  private routes = new LspRouteState();
  private instances: LspInstanceLifecycle;
  private sessions: LspManagerSessionCoordinator;

  constructor(private deps: LspManagerDeps) {
    this.instances = new LspInstanceLifecycle(
      deps,
      this.routes,
      (projectId, def) => this.resolveServerNode(projectId, def),
    );
    this.sessions = new LspManagerSessionCoordinator(deps, this.routes, this.instances, {
      canAcquire: (projectId, serverId) => (
        !this.uninstallingServerIds.has(serverId) && !this.stoppingProjectIds.has(projectId)
      ),
      spawn: (entry, baseDir, projectRoot, workspaceRoot, languageId, runtime) => this.spawn(
        entry,
        baseDir,
        projectRoot,
        workspaceRoot,
        languageId,
        runtime,
      ),
    });
  }

  /** Test seam retained from the pre-refactor manager. */
  private get entries(): Map<string, LspManagerEntry> {
    return this.instances.entries;
  }

  status(projectId: number, languageId: string, identity?: LspRouteIdentity): LspManagerStatus {
    return this.sessions.status(projectId, languageId, identity);
  }

  resolveStatus(projectId: number, languageId: string): Promise<LspManagerStatus> {
    return this.sessions.resolveStatus(projectId, languageId);
  }

  statusById(
    projectId: number,
    serverId: string,
    languageId: string,
    identity?: LspRouteIdentity,
  ): LspManagerStatus {
    return this.sessions.statusById(projectId, serverId, languageId, identity);
  }

  statusByRouteId(projectId: number, routeId: string): LspManagerStatus {
    return this.sessions.statusByRouteId(projectId, routeId);
  }

  /** Runtime-only route metadata for host-side coherence validation. */
  routeTarget(projectId: number, routeId: string): LspBoundRouteTarget | null {
    const binding = this.routes.binding(projectId, routeId);
    return binding ? {
      routeId,
      serverId: binding.serverId,
      languageId: binding.languageId,
      familyId: binding.route.familyId,
      profileId: binding.route.profileId,
      workspaceRoot: binding.workspaceRoot,
    } : null;
  }

  async acquire(
    projectId: number,
    languageId: string,
    intent: LspAcquireIntent = 'manual',
    identity?: LspRouteIdentity,
  ): Promise<LspAcquiredServer | null> {
    return this.sessions.acquire(projectId, languageId, intent, identity);
  }

  async acquireById(
    projectId: number,
    serverId: string,
    intent: LspAcquireIntent = 'manual',
    identity?: LspRouteIdentity,
  ): Promise<LspAcquiredServer | null> {
    return this.sessions.acquireById(projectId, serverId, intent, identity);
  }

  async acquireByRouteId(
    projectId: number,
    routeId: string,
    intent: LspAcquireIntent = 'manual',
  ): Promise<LspAcquiredServer | null> {
    return this.sessions.acquireByRouteId(projectId, routeId, intent);
  }

  /** Test seam retained while implementation lives in the lifecycle helper. */
  private spawn(
    entry: LspManagerEntry,
    baseDir: string,
    projectRoot: string,
    workspaceRoot: string,
    languageId: string,
    runtime?: LspRuntimeResolution,
  ): Promise<LspServerHandle | null> {
    return this.instances.spawn(entry, baseDir, projectRoot, workspaceRoot, languageId, runtime);
  }

  forEachReady(
    projectId: number,
    fn: (handle: LspServerHandle, def: LspServerDef, root: string, routeId?: string) => void,
    routeId?: string,
  ): void {
    this.instances.forEachReady(projectId, fn, routeId);
  }

  listInstances(): LspManagerInstance[] {
    return this.instances.listInstances();
  }

  activateProject(projectId: number): void {
    this.instances.activateProject(projectId);
  }

  parkProject(projectId: number): Promise<void> {
    return this.instances.parkProject(projectId);
  }

  async restart(projectId: number, serverId: string, identity?: LspRouteIdentity): Promise<boolean> {
    const def = serverById(serverId);
    if (!def) return false;
    const route = identity ? defineLspRoute(identity) : undefined;
    const entry = this.instances.entries.get(this.routes.entryKey(projectId, serverId, route));
    if (entry) await this.resetAndStop(entry);
    const acquired = await this.sessions.acquireDefinition(
      projectId,
      def,
      def.languages[0] ?? 'plaintext',
      'manual',
      identity,
    );
    return acquired !== null;
  }

  async stopRoute(projectId: number, routeId: string): Promise<boolean> {
    const binding = this.routes.binding(projectId, routeId);
    const entry = this.instances.entries.get(this.routes.routeKey(projectId, routeId));
    if (!binding && !entry) return false;
    if (entry) this.instances.clearDiagnostics(entry);
    await this.instances.stopMatching(
      (candidate) => candidate.projectId === projectId && candidate.route?.routeId === routeId,
    );
    const languages = entry?.def.languages
      ?? (binding ? serverById(binding.serverId)?.languages : undefined)
      ?? [];
    for (const languageId of languages) {
      this.deps.onRoutingChange?.(projectId, languageId, routeId);
    }
    return true;
  }

  /** Permanently forget stale framework routes after their metadata changes. */
  async retireRoutes(projectId: number, familyId: string, changedPath?: string): Promise<number> {
    const bindings = this.routes.bindingsForFamily(projectId, familyId)
      .filter((binding) => (
        !changedPath || lspRouteAffectedByPath(binding.workspaceRoot, changedPath)
      ));
    await Promise.allSettled(bindings.map(async (binding) => {
      const routeId = binding.route.routeId;
      this.routes.forgetRoute(projectId, routeId);
      try {
        const entry = this.instances.entries.get(this.routes.routeKey(projectId, routeId));
        if (entry) this.instances.clearDiagnostics(entry);
        this.deps.onRouteRetired?.(projectId, binding.serverId, routeId);
        await this.instances.stopMatching((candidate) =>
          candidate.projectId === projectId && candidate.route?.routeId === routeId);
        this.deps.onRoutingChange?.(projectId, binding.languageId, routeId);
      } finally { this.routes.finishRouteRetirement(projectId, routeId); }
    }));
    return bindings.length;
  }

  async restartRoute(projectId: number, routeId: string): Promise<boolean> {
    const binding = this.routes.binding(projectId, routeId);
    const def = binding ? serverById(binding.serverId) : undefined;
    if (!binding || !def) return false;
    const entry = this.instances.entries.get(this.routes.routeKey(projectId, routeId));
    if (entry) await this.resetAndStop(entry);
    return await this.sessions.acquireDefinition(
      projectId, def, binding.languageId, 'manual', binding.route,
    ) !== null;
  }

  private async resetAndStop(entry: LspManagerEntry): Promise<void> {
    entry.crashTimes = [];
    entry.lastExitReason = undefined;
    await this.instances.stopMatching((candidate) => candidate === entry);
  }

  async stopProject(projectId: number): Promise<void> {
    this.instances.activateProject(projectId);
    this.stoppingProjectIds.add(projectId);
    try {
      await this.instances.stopMatching((entry) => entry.projectId === projectId);
    } finally {
      this.routes.forgetProject(projectId);
      this.stoppingProjectIds.delete(projectId);
    }
  }

  async stopServer(serverId: string): Promise<void> {
    const affected = this.routes.affectedByServer(serverId, this.instances.entries.values());
    for (const entry of this.instances.entries.values()) {
      if (entry.def.id === serverId) this.instances.clearDiagnostics(entry);
    }
    await this.instances.stopMatching((entry) => entry.def.id === serverId);
    this.refreshRoutes(affected);
  }

  private refreshRoutes(routes: Map<string, LspRouteSelection>): void {
    for (const { projectId, languageId, routeId } of routes.values()) {
      if (routeId) this.statusByRouteId(projectId, routeId);
      else this.status(projectId, languageId);
      this.deps.onRoutingChange?.(projectId, languageId, routeId);
    }
  }

  async uninstallServer(serverId: string, removeFiles: () => boolean): Promise<boolean> {
    const affected = this.routes.affectedByServer(serverId, this.instances.entries.values());
    this.uninstallingServerIds.add(serverId);
    try {
      for (const entry of this.instances.entries.values()) {
        if (entry.def.id === serverId) this.instances.clearDiagnostics(entry);
      }
      await this.instances.stopMatching((entry) => entry.def.id === serverId);
      try {
        return removeFiles();
      } finally {
        this.refreshRoutes(affected);
      }
    } finally {
      this.uninstallingServerIds.delete(serverId);
    }
  }

  async stopAll(): Promise<void> {
    await this.instances.stopAll();
    this.routes.clear();
  }

  private resolveServerNode(projectId: number, def: LspServerDef): {
    command: string; env?: Record<string, string>;
  } {
    return resolveLspServerNode(this.deps, projectId, def);
  }
}

let singleton: LspServerManager | null = null;

/** First call wires deps; later calls reuse (two-factory Electron reality). */
export function getLspServerManager(deps?: LspManagerDeps): LspServerManager | null {
  if (!singleton && deps) singleton = new LspServerManager(deps);
  return singleton;
}
