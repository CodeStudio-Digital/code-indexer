/**
 * Lifecycle owner for external LSP servers — one instance per
 * (projectId, serverId), lazy-spawned on first use, idle-killed
 * (MCP_LSP_IDLE_MS, default 10min), restarted with backoff (1s/5s/30s,
 * max 3 crashes per 5min → `failed` until the window clears). On every
 * (re)spawn the open documents are REPLAYED from the document store via
 * the injected provider — crash recovery and idle-kill share the path.
 *
 * MODULE SINGLETON via getLspServerManager(): the api-handlers factory
 * runs twice on Electron, and two managers would mean two intelephense
 * per project.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { lspServersBaseDir } from '@mcp/shared/utils/data-paths.js';
import { relToAbsCanonical } from '@mcp/shared/utils/fs-canonical.js';
import { LspServerHandle } from './lsp-server-handle.js';
import type { LspDiagnostic } from './lsp-protocol.js';
import { installDirFor, isInstalled, serverById, serverForLanguage, spawnSpecFor, type LspRuntimeResolution, type LspServerDef } from './server-registry.js';

export interface LspManagerDeps {
  baseDir?: string;
  /** Managed-Node bin dir for the project (null = PATH `node`). */
  resolveNodeBin: (projectId: number) => string | null;
  resolveRoot: (projectId: number) => string | null;
  listProjectRoots?: () => string[];
  resolveRuntime: (projectId: number, requirement: NonNullable<LspServerDef['runtime']>) => LspRuntimeResolution;
  /** Open buffers for replay after (re)spawn — rel paths + content. */
  docsForReplay: (projectId: number, languages: string[]) => Array<{
    file: string; languageId: string; version: number; content: string;
  }>;
  onDiagnostics: (projectId: number, absPath: string, serverId: string, diagnostics: LspDiagnostic[]) => void;
  /** Fired on every server lifecycle transition — drives the live chip. */
  onStateChange?: (projectId: number, serverId: string, state: LspInstanceState, reason?: string) => void;
  /** Versão da linguagem do projeto p/ este server (initializationOptions). undefined = default. */
  resolveLanguageLevel?: (projectId: number, serverId: string) => string | undefined;
  /** Config dinâmica per-projeto para `workspace/configuration` (section pedido pelo server). */
  resolveLspConfig?: (projectId: number, serverId: string, section: string | null) => unknown;
  log?: (msg: string) => void;
}

export type LspInstanceState = 'no-server' | 'not-installed' | 'idle' | 'starting' | 'ready' | 'failed' | 'disabled';
export type LspAcquireIntent = 'status' | 'open' | 'background' | 'interactive' | 'manual';

interface Entry {
  def: LspServerDef;
  projectId: number;
  handle: LspServerHandle | null;
  spawning: Promise<LspServerHandle | null> | null;
  crashTimes: number[];
  idleTimer: ReturnType<typeof setTimeout> | null;
  /** Short, human-readable reason for the last failure (stderr tail / timeout). */
  lastExitReason?: string;
  workspaceMode?: 'project' | 'generated-unity' | 'generated-basic' | 'loose';
  workspaceReason?: string;
}

// Four attempts before the honest "failed" lock — a slow disk / AV scan on
// Windows can lose the first 1-2 spawns; widening tolerance avoids a sticky
// red state for transient startup hiccups. inFailedWindow uses `.length`.
const BACKOFF_MS = [1_000, 3_000, 8_000, 20_000];
const CRASH_WINDOW_MS = 5 * 60_000;
/** Servers (intelephense/pyright) need a modern Node — old managed runtimes
 *  picked for RUNNING the user's app crash them at load (SyntaxError → exit 1). */
const MIN_SERVER_NODE_MAJOR = 18;

function idleMs(): number {
  const v = Number(process.env.MCP_LSP_IDLE_MS);
  return Number.isFinite(v) && v > 0 ? v : 600_000;
}

function warmProjectLimit(): number {
  const value = Number(process.env.MCP_LSP_WARM_PROJECTS);
  return Number.isFinite(value) && value >= 0 ? Math.floor(value) : 2;
}

export class LspServerManager {
  private entries = new Map<string, Entry>();
  /** Prevent a concurrent editor request from respawning a server mid-uninstall. */
  private uninstallingServerIds = new Set<string>();
  /** Prevent requests for a project from racing its view-lifecycle teardown. */
  private stoppingProjectIds = new Set<number>();
  /** Project ids with no active view, oldest timestamp first for warm LRU. */
  private inactiveProjects = new Map<number, number>();
  private lruEvictions = 0;

  constructor(private deps: LspManagerDeps) {}

  private key(projectId: number, serverId: string): string {
    return `${projectId}:${serverId}`;
  }

  status(projectId: number, languageId: string): { state: LspInstanceState; server?: LspServerDef; reason?: string; runtime?: LspRuntimeResolution; workspaceMode?: Entry['workspaceMode']; workspaceReason?: string } {
    if (process.env.MCP_LSP_ENABLED === '0') return { state: 'disabled' };
    const def = serverForLanguage(languageId);
    if (!def) return { state: 'no-server' };
    const runtime = def.runtime ? this.deps.resolveRuntime(projectId, def.runtime) : undefined;
    if (!isInstalled(this.deps.baseDir ?? lspServersBaseDir(), def)) return { state: 'not-installed', server: def, runtime };
    if (runtime && !runtime.satisfied) return { state: 'failed', server: def, reason: runtime.reason, runtime };
    const entry = this.entries.get(this.key(projectId, def.id));
    if (entry?.handle?.state === 'ready') return { state: 'ready', server: def, runtime, workspaceMode: entry.workspaceMode, workspaceReason: entry.workspaceReason };
    if (entry && this.inFailedWindow(entry)) return {
      state: 'failed', server: def, reason: entry.lastExitReason, runtime,
      workspaceMode: entry.workspaceMode, workspaceReason: entry.workspaceReason,
    };
    if (entry?.spawning) return {
      state: 'starting', server: def, runtime,
      workspaceMode: entry.workspaceMode, workspaceReason: entry.workspaceReason,
    };
    return { state: 'idle', server: def, runtime, workspaceMode: entry?.workspaceMode, workspaceReason: entry?.workspaceReason };
  }

  /** Emit a lifecycle transition to the (optional) status subscriber. */
  private emit(entry: Entry, state: LspInstanceState, reason?: string): void {
    if (reason !== undefined) entry.lastExitReason = reason;
    this.deps.onStateChange?.(entry.projectId, entry.def.id, state, reason ?? entry.lastExitReason);
  }

  /** Ready handle or null (no server / not installed / blocked cold-start / failed budget). */
  async acquire(
    projectId: number,
    languageId: string,
    intent: LspAcquireIntent = 'manual',
  ): Promise<{ handle: LspServerHandle; def: LspServerDef; root: string } | null> {
    if (process.env.MCP_LSP_ENABLED === '0') return null;
    const def = serverForLanguage(languageId);
    if (!def) return null;
    return this.acquireDefinition(projectId, def, languageId, intent);
  }

  /** Acquire the exact origin server for resolve/execute round-trips. */
  async acquireById(
    projectId: number,
    serverId: string,
    intent: LspAcquireIntent = 'manual',
  ): Promise<{ handle: LspServerHandle; def: LspServerDef; root: string } | null> {
    if (process.env.MCP_LSP_ENABLED === '0') return null;
    const def = serverById(serverId);
    if (!def) return null;
    return this.acquireDefinition(projectId, def, def.languages[0] ?? 'plaintext', intent);
  }

  private async acquireDefinition(
    projectId: number,
    def: LspServerDef,
    languageId: string,
    intent: LspAcquireIntent,
  ): Promise<{ handle: LspServerHandle; def: LspServerDef; root: string } | null> {
    if (this.uninstallingServerIds.has(def.id) || this.stoppingProjectIds.has(projectId)) return null;
    this.activateProject(projectId);
    // Ready fast path FIRST: every hover/completion/codeAction acquires on the
    // shared main loop, so a warm server must not re-pay isInstalled (sync
    // existsSync) nor resolveRuntime (sync fs sweep across SDK roots).
    const k = this.key(projectId, def.id);
    let entry = this.entries.get(k);
    if (entry?.handle?.state === 'ready') {
      const root = this.deps.resolveRoot(projectId);
      if (!root) return null;
      this.touch(entry);
      return { handle: entry.handle, def, root };
    }

    // Heavy servers stay installed but cold until a user-driven request. If a
    // spawn is already underway, every intent may share it; only NEW cold
    // starts from status/open/background are rejected.
    if (!entry?.spawning && def.activation === 'interactive'
      && intent !== 'interactive' && intent !== 'manual') return null;

    const baseDir = this.deps.baseDir ?? lspServersBaseDir();
    if (!isInstalled(baseDir, def)) return null;
    const root = this.deps.resolveRoot(projectId);
    if (!root) return null;
    const runtime = def.runtime ? this.deps.resolveRuntime(projectId, def.runtime) : undefined;
    if (runtime && !runtime.satisfied) return null;

    if (!entry) {
      entry = { def, projectId, handle: null, spawning: null, crashTimes: [], idleTimer: null };
      this.entries.set(k, entry);
    }
    if (this.inFailedWindow(entry)) return null;
    if (!entry.spawning) entry.spawning = this.spawn(entry, baseDir, root, languageId, runtime);
    const handle = await entry.spawning;
    return handle ? { handle, def, root } : null;
  }

  forEachReady(projectId: number, fn: (handle: LspServerHandle, def: LspServerDef, root: string) => void): void {
    for (const entry of this.entries.values()) {
      if (entry.projectId !== projectId) continue;
      if (entry.handle?.state !== 'ready') continue;
      const root = this.deps.resolveRoot(projectId);
      if (root) { this.touch(entry); fn(entry.handle, entry.def, root); }
    }
  }

  listInstances(): Array<{
    projectId: number;
    serverId: string;
    state: string;
    lastExitReason?: string;
    stderrTail?: string;
    requests?: ReturnType<LspServerHandle['requestStats']>;
    inactive?: boolean;
    lruEvictions?: number;
    workspaceMode?: Entry['workspaceMode'];
    workspaceReason?: string;
  }> {
    return [...this.entries.values()]
      .filter((e) => !!e.handle || !!e.spawning || this.inFailedWindow(e))
      .map((e) => ({
      projectId: e.projectId,
      serverId: e.def.id,
      state: e.handle?.state ?? (e.spawning ? 'starting' : this.inFailedWindow(e) ? 'failed' : 'idle'),
      // LSP Doctor (Fase 0) — motivo da última falha + cauda do stderr p/ diagnóstico de P2.
      lastExitReason: e.lastExitReason,
      stderrTail: e.handle?.stderrTail?.trim().slice(-400) || undefined,
      requests: e.handle?.requestStats(),
      inactive: this.inactiveProjects.has(e.projectId) || undefined,
      lruEvictions: this.lruEvictions || undefined,
      workspaceMode: e.workspaceMode,
      workspaceReason: e.workspaceReason,
    }));
  }

  /** A real request/view makes a parked project most-recent and active again. */
  activateProject(projectId: number): void {
    this.inactiveProjects.delete(projectId);
  }

  /**
   * Keep ready processes warm, but bound inactive instances globally. Documents
   * are closed by the project handler before this method is called.
   */
  async parkProject(projectId: number): Promise<void> {
    this.inactiveProjects.delete(projectId);
    this.inactiveProjects.set(projectId, Date.now());
    const limit = warmProjectLimit();
    const inactiveEntries = (): Entry[] => [...this.entries.values()]
      .filter((entry) => this.inactiveProjects.has(entry.projectId) && (!!entry.handle || !!entry.spawning))
      .sort((a, b) => (this.inactiveProjects.get(a.projectId) ?? 0) - (this.inactiveProjects.get(b.projectId) ?? 0));

    while (inactiveEntries().length > limit) {
      const victim = inactiveEntries()[0];
      if (!victim) break;
      await this.stopMatching((entry) => entry === victim);
      this.lruEvictions += 1;
      if (![...this.entries.values()].some((entry) => entry.projectId === victim.projectId)) {
        this.inactiveProjects.delete(victim.projectId);
      }
    }
  }

  async restart(projectId: number, serverId: string): Promise<void> {
    const def = serverById(serverId);
    if (!def) return;
    const entry = this.entries.get(this.key(projectId, serverId));
    if (entry) {
      entry.crashTimes = [];
      entry.lastExitReason = undefined;
      await this.stopMatching((candidate) => candidate === entry);
    }
    await this.acquireDefinition(projectId, def, def.languages[0] ?? 'plaintext', 'manual');
  }

  private async stopMatching(predicate: (entry: Entry) => boolean): Promise<void> {
    const matches = [...this.entries.entries()].filter(([, entry]) => predicate(entry));
    await Promise.allSettled(matches.map(async ([key, entry]) => {
      if (entry.idleTimer) {
        clearTimeout(entry.idleTimer);
        entry.idleTimer = null;
      }

      // A server may still be inside initialize(). Wait for that shared spawn
      // so teardown cannot leave a late child process behind.
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

  /** Stop and forget every language-server process owned by one project. */
  async stopProject(projectId: number): Promise<void> {
    this.inactiveProjects.delete(projectId);
    this.stoppingProjectIds.add(projectId);
    try {
      await this.stopMatching((entry) => entry.projectId === projectId);
    } finally {
      this.stoppingProjectIds.delete(projectId);
    }
  }

  /**
   * Stop every live instance before removing its install directory. Native
   * servers keep their executable locked on Windows, so deleting first makes
   * an otherwise valid uninstall fail with EPERM. The guard also prevents an
   * editor request from starting the server again between stop and removal.
   */
  async uninstallServer(serverId: string, removeFiles: () => boolean): Promise<boolean> {
    this.uninstallingServerIds.add(serverId);
    try {
      await this.stopMatching((entry) => entry.def.id === serverId);
      return removeFiles();
    } finally {
      this.uninstallingServerIds.delete(serverId);
    }
  }

  async stopAll(): Promise<void> {
    await Promise.allSettled(
      [...this.entries.values()].map(async (e) => {
        if (e.idleTimer) clearTimeout(e.idleTimer);
        await e.handle?.stop();
      }),
    );
    this.entries.clear();
    this.inactiveProjects.clear();
  }

  // ─── Internals ────────────────────────────────────────────────────

  private inFailedWindow(entry: Entry): boolean {
    const now = Date.now();
    entry.crashTimes = entry.crashTimes.filter((t) => now - t < CRASH_WINDOW_MS);
    return entry.crashTimes.length >= BACKOFF_MS.length;
  }

  private touch(entry: Entry): void {
    if (entry.idleTimer) clearTimeout(entry.idleTimer);
    entry.idleTimer = setTimeout(() => {
      this.deps.log?.(`[lsp] ${entry.def.id} (project ${entry.projectId}) idle — stopping`);
      entry.idleTimer = null;
      const handle = entry.handle;
      entry.handle = null;
      entry.spawning = null;
      void Promise.resolve(handle?.stop())
        .catch((err) => this.deps.log?.(`[lsp] ${entry.def.id} idle stop failed: ${err instanceof Error ? err.message : String(err)}`))
        .finally(() => {
          const key = this.key(entry.projectId, entry.def.id);
          // Do not delete a replacement spawned by a request that arrived
          // while the old process was shutting down.
          if (this.entries.get(key) === entry && !entry.handle && !entry.spawning) {
            this.emit(entry, 'idle');
            this.entries.delete(key);
          }
        });
    }, idleMs());
    entry.idleTimer.unref?.();
  }

  private async spawn(
    entry: Entry,
    baseDir: string,
    root: string,
    languageId: string,
    runtime?: LspRuntimeResolution,
  ): Promise<LspServerHandle | null> {
    const { def, projectId } = entry;
    this.emit(entry, 'starting');
    // Backoff proportional to recent crashes.
    const recent = entry.crashTimes.length;
    if (recent > 0) await new Promise((r) => setTimeout(r, BACKOFF_MS[Math.min(recent, BACKOFF_MS.length) - 1]));

    const installDir = installDirFor(baseDir, def);
    // npm defs launch as `node <entry> --stdio`; binary defs exec the
    // executable directly (resolveServerNode is only consulted for npm —
    // native servers must not inherit ELECTRON_RUN_AS_NODE).
    const spawnSpec = spawnSpecFor(
      def,
      installDir,
      () => this.resolveServerNode(projectId),
      languageId,
      runtime ? {
        baseDir,
        projectId,
        projectRoot: root,
        runtime,
        registeredProjectRoots: this.deps.listProjectRoots?.(),
      } : undefined,
    );
    if (!existsSync(spawnSpec.checkPath)) {
      this.deps.log?.(`[lsp] entry missing for ${def.id}: ${spawnSpec.checkPath}`);
      entry.spawning = null;
      this.emit(entry, 'failed', `server entry missing: ${spawnSpec.checkPath}`);
      return null;
    }
    entry.workspaceMode = spawnSpec.workspaceMode;
    entry.workspaceReason = spawnSpec.workspaceReason;

    let handle: LspServerHandle | null = null;
    try {
      const languageLevel = this.deps.resolveLanguageLevel?.(projectId, def.id);
      handle = new LspServerHandle(
        {
          command: spawnSpec.command,
          args: spawnSpec.args,
          cwd: spawnSpec.cwd ?? root,
          rootPath: spawnSpec.rootPath ?? root,
          env: spawnSpec.env,
          priority: spawnSpec.priority,
          initializationOptions: def.initializationOptions?.({ cacheDir: join(baseDir, '.cache'), languageLevel }),
          workspaceFolders: def.workspaceFolders,
          initializeTimeoutMs: def.id === 'omnisharp' ? 120_000 : undefined,
          resolveConfig: (section) => this.deps.resolveLspConfig?.(projectId, def.id, section) ?? null,
        },
        {
          onDiagnostics: (absPath, diagnostics) => this.deps.onDiagnostics(projectId, absPath, def.id, diagnostics),
          onExit: () => {
            entry.crashTimes.push(Date.now());
            entry.handle = null;
            entry.spawning = null;
            const tail = handle?.stderrTail.trim().slice(-400);
            this.deps.log?.(
              `[lsp] ${def.id} (project ${projectId}) exited unexpectedly (${entry.crashTimes.length} recent)` +
              (tail ? ` — stderr: ${tail}` : ''),
            );
            // Failed only once the retry budget is spent; otherwise remain
            // installed-but-idle until the next permitted acquire.
            const reason = tail || 'server exited unexpectedly';
            this.emit(entry, this.inFailedWindow(entry) ? 'failed' : 'idle', reason);
          },
          log: (msg) => this.deps.log?.(`[lsp:${def.id}] ${msg}`),
        },
      );
      await handle.whenReady();
      entry.handle = handle;
      entry.spawning = null;
      this.touch(entry);
      // Replay every open buffer of this server's languages — chave de path canônica
      // (W3) idêntica à da completion, senão o ensureOpen re-abre e o server pode divergir.
      for (const doc of this.deps.docsForReplay(projectId, def.languages)) {
        handle.didOpen(relToAbsCanonical(root, doc.file), doc.languageId, doc.version, doc.content);
      }
      this.deps.log?.(`[lsp] ${def.id} ready for project ${projectId}`);
      this.emit(entry, 'ready');
      return handle;
    } catch (err) {
      entry.crashTimes.push(Date.now());
      entry.spawning = null;
      const tail = handle?.stderrTail.trim().slice(-400);
      const msg = err instanceof Error ? err.message : String(err);
      this.deps.log?.(
        `[lsp] ${def.id} failed to start: ${msg}` + (tail ? ` — stderr: ${tail}` : ''),
      );
      // Init-timeout reads as a friendlier reason than the raw stderr ring.
      const reason = /timed out/i.test(msg) ? 'initialization timed out (30s)' : (tail || msg);
      this.emit(entry, this.inFailedWindow(entry) ? 'failed' : 'idle', reason);
      return null;
    }
  }

  /**
   * Node executable FOR THE SERVER — deliberately independent of the
   * project's runtime pick. A managed runtime pinned to an old major
   * (downloaded to RUN the user's app, e.g. v14) crashes modern language
   * servers at load with a bare exit 1. Policy: managed node only when
   * ≥ MIN_SERVER_NODE_MAJOR; under Electron use the bundled Node
   * (ELECTRON_RUN_AS_NODE — packaged apps have no PATH node); else PATH.
   */
  private resolveServerNode(projectId: number): { command: string; env?: Record<string, string> } {
    const nodeBin = this.deps.resolveNodeBin(projectId);
    if (nodeBin) {
      const major = /[\\/]v?(\d+)\.\d+\.\d+/.exec(nodeBin);
      if (major && Number(major[1]) >= MIN_SERVER_NODE_MAJOR) {
        return { command: join(nodeBin, process.platform === 'win32' ? 'node.exe' : 'node') };
      }
      this.deps.log?.(
        `[lsp] project ${projectId} managed node (${nodeBin}) is too old for language servers — using app runtime`,
      );
    }
    if (process.versions.electron) {
      return { command: process.execPath, env: { ELECTRON_RUN_AS_NODE: '1' } };
    }
    return { command: 'node' };
  }
}

let singleton: LspServerManager | null = null;

/** First call wires deps; later calls reuse (two-factory Electron reality). */
export function getLspServerManager(deps?: LspManagerDeps): LspServerManager | null {
  if (!singleton && deps) singleton = new LspServerManager(deps);
  return singleton;
}
