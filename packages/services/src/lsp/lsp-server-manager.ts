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
import { LspServerHandle } from './lsp-server-handle.js';
import type { LspDiagnostic } from './lsp-protocol.js';
import { entryFor, installDirFor, isInstalled, serverForLanguage, type LspServerDef } from './server-registry.js';

export interface LspManagerDeps {
  baseDir?: string;
  /** Managed-Node bin dir for the project (null = PATH `node`). */
  resolveNodeBin: (projectId: number) => string | null;
  resolveRoot: (projectId: number) => string | null;
  /** Open buffers for replay after (re)spawn — rel paths + content. */
  docsForReplay: (projectId: number, languages: string[]) => Array<{
    file: string; languageId: string; version: number; content: string;
  }>;
  onDiagnostics: (projectId: number, absPath: string, serverId: string, diagnostics: LspDiagnostic[]) => void;
  /** Fired on every server lifecycle transition — drives the live chip. */
  onStateChange?: (projectId: number, serverId: string, state: LspInstanceState, reason?: string) => void;
  log?: (msg: string) => void;
}

export type LspInstanceState = 'no-server' | 'not-installed' | 'starting' | 'ready' | 'failed' | 'disabled';

interface Entry {
  def: LspServerDef;
  projectId: number;
  handle: LspServerHandle | null;
  spawning: Promise<LspServerHandle | null> | null;
  crashTimes: number[];
  idleTimer: ReturnType<typeof setTimeout> | null;
  /** Short, human-readable reason for the last failure (stderr tail / timeout). */
  lastExitReason?: string;
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

export class LspServerManager {
  private entries = new Map<string, Entry>();

  constructor(private deps: LspManagerDeps) {}

  private key(projectId: number, serverId: string): string {
    return `${projectId}:${serverId}`;
  }

  status(projectId: number, languageId: string): { state: LspInstanceState; server?: LspServerDef; reason?: string } {
    if (process.env.MCP_LSP_ENABLED === '0') return { state: 'disabled' };
    const def = serverForLanguage(languageId);
    if (!def) return { state: 'no-server' };
    if (!isInstalled(this.deps.baseDir ?? lspServersBaseDir(), def)) return { state: 'not-installed', server: def };
    const entry = this.entries.get(this.key(projectId, def.id));
    if (entry?.handle?.state === 'ready') return { state: 'ready', server: def };
    if (entry && this.inFailedWindow(entry)) return { state: 'failed', server: def, reason: entry.lastExitReason };
    if (entry?.spawning) return { state: 'starting', server: def };
    return { state: 'starting', server: def }; // will lazy-spawn on first use
  }

  /** Emit a lifecycle transition to the (optional) status subscriber. */
  private emit(entry: Entry, state: LspInstanceState, reason?: string): void {
    if (reason !== undefined) entry.lastExitReason = reason;
    this.deps.onStateChange?.(entry.projectId, entry.def.id, state, reason ?? entry.lastExitReason);
  }

  /** Ready handle or null (no server / not installed / failed budget). */
  async acquire(projectId: number, languageId: string): Promise<{ handle: LspServerHandle; def: LspServerDef; root: string } | null> {
    if (process.env.MCP_LSP_ENABLED === '0') return null;
    const def = serverForLanguage(languageId);
    if (!def) return null;
    const baseDir = this.deps.baseDir ?? lspServersBaseDir();
    if (!isInstalled(baseDir, def)) return null;
    const root = this.deps.resolveRoot(projectId);
    if (!root) return null;

    const k = this.key(projectId, def.id);
    let entry = this.entries.get(k);
    if (!entry) {
      entry = { def, projectId, handle: null, spawning: null, crashTimes: [], idleTimer: null };
      this.entries.set(k, entry);
    }
    if (entry.handle && entry.handle.state === 'ready') {
      this.touch(entry);
      return { handle: entry.handle, def, root };
    }
    if (this.inFailedWindow(entry)) return null;
    if (!entry.spawning) entry.spawning = this.spawn(entry, baseDir, root, languageId);
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

  listInstances(): Array<{ projectId: number; serverId: string; state: string }> {
    return [...this.entries.values()].map((e) => ({
      projectId: e.projectId,
      serverId: e.def.id,
      state: e.handle?.state ?? (e.spawning ? 'starting' : this.inFailedWindow(e) ? 'failed' : 'idle'),
    }));
  }

  async restart(projectId: number, serverId: string): Promise<void> {
    const entry = this.entries.get(this.key(projectId, serverId));
    if (!entry) return;
    entry.crashTimes = [];
    entry.lastExitReason = undefined;
    await entry.handle?.stop();
    entry.handle = null;
    entry.spawning = null;
    // Flip the chip out of the red state immediately; the next acquire (or
    // the warm-acquire on the next status poll) drives starting→ready.
    this.emit(entry, 'starting');
  }

  async stopAll(): Promise<void> {
    await Promise.allSettled(
      [...this.entries.values()].map(async (e) => {
        if (e.idleTimer) clearTimeout(e.idleTimer);
        await e.handle?.stop();
      }),
    );
    this.entries.clear();
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
      void entry.handle?.stop();
      entry.handle = null;
      entry.spawning = null;
    }, idleMs());
    entry.idleTimer.unref?.();
  }

  private async spawn(entry: Entry, baseDir: string, root: string, languageId: string): Promise<LspServerHandle | null> {
    const { def, projectId } = entry;
    this.emit(entry, 'starting');
    // Backoff proportional to recent crashes.
    const recent = entry.crashTimes.length;
    if (recent > 0) await new Promise((r) => setTimeout(r, BACKOFF_MS[Math.min(recent, BACKOFF_MS.length) - 1]));

    const installDir = installDirFor(baseDir, def);
    const entryJs = entryFor(installDir, def, languageId);
    if (!existsSync(entryJs)) {
      this.deps.log?.(`[lsp] entry missing for ${def.id}: ${entryJs}`);
      entry.spawning = null;
      this.emit(entry, 'failed', `server entry missing: ${entryJs}`);
      return null;
    }
    const node = this.resolveServerNode(projectId);

    let handle: LspServerHandle | null = null;
    try {
      handle = new LspServerHandle(
        {
          command: node.command,
          args: [entryJs, ...def.args],
          cwd: root,
          rootPath: root,
          env: node.env,
          initializationOptions: def.initializationOptions?.({ cacheDir: join(baseDir, '.cache') }),
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
            // Failed only once the retry budget is spent; otherwise the next
            // acquire respawns (chip shows starting, not a hard red).
            const reason = tail || 'server exited unexpectedly';
            this.emit(entry, this.inFailedWindow(entry) ? 'failed' : 'starting', reason);
          },
          log: (msg) => this.deps.log?.(`[lsp:${def.id}] ${msg}`),
        },
      );
      await handle.whenReady();
      entry.handle = handle;
      entry.spawning = null;
      this.touch(entry);
      // Replay every open buffer of this server's languages.
      for (const doc of this.deps.docsForReplay(projectId, def.languages)) {
        handle.didOpen(`${root.replace(/\\/g, '/')}/${doc.file}`, doc.languageId, doc.version, doc.content);
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
      this.emit(entry, this.inFailedWindow(entry) ? 'failed' : 'starting', reason);
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
