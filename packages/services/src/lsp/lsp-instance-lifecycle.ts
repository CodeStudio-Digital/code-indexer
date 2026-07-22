import { relToAbsCanonical } from '@mcp/shared/utils/fs-canonical.js';
import { lspRouteOwnsDocument, workspaceRootForLspRoute } from './lsp-route.js';
import { inLspFailureWindow, lspIdleMs, lspWarmProjectLimit } from './lsp-instance-policy.js';
import { spawnLspEntry } from './lsp-instance-spawn.js';
import type { LspRouteState } from './lsp-route-state.js';
import type {
  LspInstanceState,
  LspManagerDeps,
  LspManagerEntry,
  LspManagerInstance,
  LspReplayDocument,
} from './lsp-server-manager-types.js';
import type { LspServerHandle } from './lsp-server-handle.js';
import type { LspRuntimeResolution, LspServerDef } from './server-registry.js';

type NodeResolver = (
  projectId: number,
  def: LspServerDef,
) => { command: string; env?: Record<string, string> };

/** Owns live entry state, replay, idle/LRU policy and process teardown. */
export class LspInstanceLifecycle {
  readonly entries = new Map<string, LspManagerEntry>();
  private inactiveProjects = new Map<number, number>();
  private lruEvictions = 0;

  constructor(
    private deps: LspManagerDeps,
    private routes: LspRouteState,
    private resolveServerNode: NodeResolver,
  ) {}

  inFailedWindow(entry: LspManagerEntry): boolean {
    return inLspFailureWindow(entry);
  }

  emit(entry: LspManagerEntry, state: LspInstanceState, reason?: string): void {
    if (reason !== undefined) entry.lastExitReason = reason;
    this.deps.onStateChange?.(
      entry.projectId,
      entry.def.id,
      state,
      reason ?? entry.lastExitReason,
      entry.route?.routeId,
    );
  }

  replayDocs(entry: LspManagerEntry): { projectRoot: string; docs: LspReplayDocument[] } | null {
    const projectRoot = this.deps.resolveRoot(entry.projectId);
    if (!projectRoot) return null;
    const docs = this.deps.docsForReplay(entry.projectId, entry.def.languages);
    if (!entry.route) return { projectRoot, docs };
    const workspaceRoot = entry.workspaceRoot ?? workspaceRootForLspRoute(projectRoot, entry.route);
    return {
      projectRoot,
      docs: workspaceRoot
        ? docs.filter((doc) => lspRouteOwnsDocument(projectRoot, workspaceRoot, doc.file))
        : [],
    };
  }

  clearDiagnostics(entry: LspManagerEntry): void {
    const replay = this.replayDocs(entry);
    if (!replay) return;
    for (const doc of replay.docs) {
      this.deps.onDiagnostics(
        entry.projectId,
        relToAbsCanonical(replay.projectRoot, doc.file),
        entry.def.id,
        [],
        entry.route?.routeId,
      );
    }
  }

  touch(entry: LspManagerEntry): void {
    if (entry.idleTimer) clearTimeout(entry.idleTimer);
    entry.idleTimer = setTimeout(() => {
      this.deps.log?.(`[lsp] ${entry.def.id} (project ${entry.projectId}) idle — stopping`);
      entry.idleTimer = null;
      const handle = entry.handle;
      entry.handle = null;
      entry.spawning = null;
      void Promise.resolve(handle?.stop())
        .catch((error) => this.deps.log?.(
          `[lsp] ${entry.def.id} idle stop failed: ${error instanceof Error ? error.message : String(error)}`,
        ))
        .finally(() => {
          const key = this.routes.entryKey(entry.projectId, entry.def.id, entry.route);
          if (this.entries.get(key) === entry && !entry.handle && !entry.spawning) {
            this.emit(entry, 'idle');
            this.entries.delete(key);
          }
        });
    }, lspIdleMs());
    entry.idleTimer.unref?.();
  }

  spawn(
    entry: LspManagerEntry,
    baseDir: string,
    projectRoot: string,
    workspaceRoot: string,
    languageId: string,
    runtime?: LspRuntimeResolution,
  ): Promise<LspServerHandle | null> {
    return spawnLspEntry(
      this.deps,
      {
        emit: (item, state, reason) => this.emit(item, state, reason),
        touch: (item) => this.touch(item),
        replayDocs: (item) => this.replayDocs(item),
        resolveServerNode: this.resolveServerNode,
        acceptDiagnostics: (item) => (
          !item.route
          || item.routeEpoch === this.routes.routeEpoch(item.projectId, item.route.routeId)
        ),
      },
      entry,
      baseDir,
      projectRoot,
      workspaceRoot,
      languageId,
      runtime,
    );
  }

  forEachReady(
    projectId: number,
    fn: (handle: LspServerHandle, def: LspServerDef, root: string, routeId?: string) => void,
    routeId?: string,
  ): void {
    for (const entry of this.entries.values()) {
      if (entry.projectId !== projectId || entry.handle?.state !== 'ready') continue;
      if (routeId && entry.route?.routeId !== routeId) continue;
      const root = entry.workspaceRoot ?? this.deps.resolveRoot(projectId);
      if (root) {
        this.touch(entry);
        fn(entry.handle, entry.def, root, entry.route?.routeId);
      }
    }
  }

  listInstances(): LspManagerInstance[] {
    return [...this.entries.values()]
      .filter((entry) => (
        !!entry.handle
        || !!entry.spawning
        || !!entry.blockedReason
        || this.inFailedWindow(entry)
      ))
      .map((entry) => ({
        projectId: entry.projectId,
        serverId: entry.def.id,
        state: entry.handle?.state ?? (
          entry.spawning ? 'starting' : entry.blockedReason || this.inFailedWindow(entry) ? 'failed' : 'idle'
        ),
        lastExitReason: entry.lastExitReason,
        stderrTail: entry.handle?.stderrTail?.trim().slice(-400) || undefined,
        requests: entry.handle?.requestStats(),
        inactive: this.inactiveProjects.has(entry.projectId) || undefined,
        lruEvictions: this.lruEvictions || undefined,
        workspaceMode: entry.workspaceMode,
        workspaceReason: entry.workspaceReason,
        routeId: entry.route?.routeId,
        familyId: entry.route?.familyId,
        profileId: entry.route?.profileId,
      }));
  }

  activateProject(projectId: number): void {
    this.inactiveProjects.delete(projectId);
  }

  async parkProject(projectId: number): Promise<void> {
    this.inactiveProjects.delete(projectId);
    this.inactiveProjects.set(projectId, Date.now());
    const inactiveEntries = (): LspManagerEntry[] => [...this.entries.values()]
      .filter((entry) => this.inactiveProjects.has(entry.projectId) && (!!entry.handle || !!entry.spawning))
      .sort((a, b) => (
        (this.inactiveProjects.get(a.projectId) ?? 0) - (this.inactiveProjects.get(b.projectId) ?? 0)
      ));

    while (inactiveEntries().length > lspWarmProjectLimit()) {
      const victim = inactiveEntries()[0];
      if (!victim) break;
      await this.stopMatching((entry) => entry === victim);
      this.lruEvictions += 1;
      if (![...this.entries.values()].some((entry) => entry.projectId === victim.projectId)) {
        this.inactiveProjects.delete(victim.projectId);
      }
    }
  }

  async stopMatching(predicate: (entry: LspManagerEntry) => boolean): Promise<void> {
    const matches = [...this.entries.entries()].filter(([, entry]) => predicate(entry));
    await Promise.allSettled(matches.map(async ([key, entry]) => {
      if (entry.idleTimer) {
        clearTimeout(entry.idleTimer);
        entry.idleTimer = null;
      }
      const handle = entry.handle ?? await entry.spawning?.catch(() => null) ?? null;
      if (entry.idleTimer) {
        clearTimeout(entry.idleTimer);
        entry.idleTimer = null;
      }
      await handle?.stop();
      entry.handle = null;
      entry.spawning = null;
      if (this.entries.get(key) === entry) this.entries.delete(key);
    }));
  }

  async stopAll(): Promise<void> {
    await Promise.allSettled([...this.entries.values()].map(async (entry) => {
      if (entry.idleTimer) clearTimeout(entry.idleTimer);
      await entry.handle?.stop();
    }));
    this.entries.clear();
    this.inactiveProjects.clear();
  }
}
