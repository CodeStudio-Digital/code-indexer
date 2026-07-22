import {
  defineLspRoute,
  workspaceRootForLspRoute,
  type LspRouteDescriptor,
  type LspRouteIdentity,
} from './lsp-route.js';
import type {
  LspManagerEntry,
  LspManagerStatus,
  LspRouteBinding,
  LspRouteSelection,
} from './lsp-server-manager-types.js';

export interface LspRouteScope {
  projectRoot: string;
  workspaceRoot: string;
  route?: LspRouteDescriptor;
}

/** Owns opaque route bindings and effective language selections. */
export class LspRouteState {
  private bindings = new Map<string, LspRouteBinding>();
  private selections = new Map<string, LspRouteSelection>();
  private retiring = new Set<string>();
  private epochs = new Map<string, number>();

  routeKey(projectId: number, routeId: string): string {
    return `${projectId}:${routeId}`;
  }

  entryKey(projectId: number, serverId: string, route?: LspRouteDescriptor): string {
    return route ? this.routeKey(projectId, route.routeId) : `${projectId}:${serverId}`;
  }

  info(route?: LspRouteDescriptor): Pick<LspManagerStatus, 'routeId' | 'familyId' | 'profileId'> {
    return route
      ? { routeId: route.routeId, familyId: route.familyId, profileId: route.profileId }
      : {};
  }

  scope(
    projectId: number,
    identity: LspRouteIdentity | undefined,
    resolveRoot: (projectId: number) => string | null,
  ): LspRouteScope | null {
    const projectRoot = resolveRoot(projectId);
    if (!projectRoot) return null;
    if (!identity) return { projectRoot, workspaceRoot: projectRoot };
    const route = defineLspRoute(identity);
    const workspaceRoot = workspaceRootForLspRoute(projectRoot, route);
    return workspaceRoot ? { projectRoot, workspaceRoot, route } : null;
  }

  bind(
    projectId: number,
    serverId: string,
    languageId: string,
    route: LspRouteDescriptor,
    workspaceRoot: string,
  ): void {
    const key = this.routeKey(projectId, route.routeId);
    const existing = this.bindings.get(key);
    if (existing && (existing.workspaceRoot !== workspaceRoot || existing.serverId !== serverId)) {
      throw new Error('LSP route identity collision for two workspace roots or server profiles');
    }
    this.bindings.set(key, { projectId, serverId, languageId, route, workspaceRoot });
  }

  binding(projectId: number, routeId: string): LspRouteBinding | undefined {
    return this.bindings.get(this.routeKey(projectId, routeId));
  }

  bindingsForFamily(projectId: number, familyId: string): LspRouteBinding[] {
    return [...this.bindings.values()].filter((binding) =>
      binding.projectId === projectId && binding.route.familyId === familyId);
  }

  forgetRoute(projectId: number, routeId: string): LspRouteBinding | undefined {
    const key = this.routeKey(projectId, routeId);
    const binding = this.bindings.get(key);
    this.retiring.add(key);
    this.epochs.set(key, (this.epochs.get(key) ?? 0) + 1);
    this.bindings.delete(key);
    for (const [selectionKey, selection] of this.selections) {
      if (selection.projectId === projectId && selection.routeId === routeId) {
        this.selections.delete(selectionKey);
      }
    }
    return binding;
  }

  isRouteRetiring(projectId: number, routeId: string): boolean {
    return this.retiring.has(this.routeKey(projectId, routeId));
  }

  finishRouteRetirement(projectId: number, routeId: string): void {
    this.retiring.delete(this.routeKey(projectId, routeId));
  }

  routeEpoch(projectId: number, routeId: string): number {
    return this.epochs.get(this.routeKey(projectId, routeId)) ?? 0;
  }

  select(
    projectId: number,
    languageId: string,
    serverId: string | undefined,
    route?: LspRouteDescriptor,
  ): void {
    const key = route
      ? `${projectId}:${languageId}:${route.routeId}`
      : `${projectId}:${languageId}`;
    this.selections.set(key, { projectId, languageId, serverId, routeId: route?.routeId });
  }

  affectedByServer(serverId: string, entries: Iterable<LspManagerEntry>): Map<string, LspRouteSelection> {
    const affected = new Map<string, LspRouteSelection>();
    const remember = (projectId: number, languageId: string, routeId?: string): void => {
      const key = routeId ? `${projectId}:${languageId}:${routeId}` : `${projectId}:${languageId}`;
      affected.set(key, { projectId, languageId, routeId });
    };
    for (const selection of this.selections.values()) {
      if (selection.serverId === serverId) {
        remember(selection.projectId, selection.languageId, selection.routeId);
      }
    }
    for (const entry of entries) {
      if (entry.def.id !== serverId) continue;
      for (const languageId of entry.def.languages) {
        remember(entry.projectId, languageId, entry.route?.routeId);
      }
    }
    return affected;
  }

  forgetProject(projectId: number): void {
    for (const [key, selection] of this.selections) {
      if (selection.projectId === projectId) this.selections.delete(key);
    }
    for (const [key, binding] of this.bindings) {
      if (binding.projectId === projectId) this.bindings.delete(key);
    }
    for (const key of this.retiring) {
      if (key.startsWith(`${projectId}:`)) this.retiring.delete(key);
    }
    for (const key of this.epochs.keys()) {
      if (key.startsWith(`${projectId}:`)) this.epochs.delete(key);
    }
  }

  clear(): void {
    this.selections.clear();
    this.bindings.clear();
    this.retiring.clear();
    this.epochs.clear();
  }
}
