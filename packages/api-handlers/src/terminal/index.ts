/**
 * Handlers for the `terminal` namespace.
 *
 * MVP scope (Dia 2): the `project` target only — a PTY rooted at the
 * project's `root_path`, which is what the IDE workspace's BottomPanel
 * mounts. The `sandbox` (podman exec) and `host` (operator shell)
 * targets are still served by the legacy `terminal-ws.ts` WebSocket
 * upgrade and will be folded into this handler in Dia 3.
 *
 * Streaming via AsyncIterable — handler returns `output()` as an iterable
 * of `{type:'data'|'exit', ...}` frames. Hono adapts to SSE (or keeps
 * the existing WS path for now); Electron pumps onto a MessagePort.
 *
 * node-pty is loaded lazily via `createRequire` so a missing prebuild on
 * exotic platforms degrades to a clean ApiError instead of failing
 * module load.
 */

import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { ApiError, type TerminalApi, type TerminalOutputChunk } from '@mcp/api-bus';
import type { HandlerDeps } from '../types.js';

interface IPty {
  pid: number;
  cols: number;
  rows: number;
  onData(listener: (data: string) => void): { dispose(): void };
  onExit(listener: (e: { exitCode: number; signal?: number }) => void): { dispose(): void };
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
}

interface NodePtyModule {
  spawn(
    file: string,
    args: string[] | string,
    opts: {
      name?: string;
      cols?: number;
      rows?: number;
      cwd?: string;
      env?: Record<string, string | undefined>;
      encoding?: string;
    },
  ): IPty;
}

const nodeRequire = createRequire(import.meta.url);
let cachedPty: NodePtyModule | null | undefined;
function loadPty(): NodePtyModule {
  if (cachedPty !== undefined && cachedPty !== null) return cachedPty;
  if (cachedPty === null) {
    throw new ApiError('terminal_unavailable', 503, 'node-pty is not available on this platform');
  }
  try {
    cachedPty = nodeRequire('node-pty') as NodePtyModule;
    return cachedPty;
  } catch (err) {
    cachedPty = null;
    throw new ApiError(
      'terminal_unavailable',
      503,
      `node-pty failed to load: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * In-process registry of live PTYs. Keyed by the opaque `terminalId`
 * returned from `spawn`. A buffered fan-out per terminal lets multiple
 * consumers attach (Electron renderer + later debug viewer, e.g.).
 */
interface PtyEntry {
  pty: IPty;
  buffer: TerminalOutputChunk[];
  listeners: Set<(chunk: TerminalOutputChunk) => void>;
  exited: boolean;
  exitChunk?: TerminalOutputChunk;
}

class PtyManager {
  private readonly entries = new Map<string, PtyEntry>();

  spawn(opts: {
    shell?: string;
    cwd: string;
    cols: number;
    rows: number;
    env?: Record<string, string>;
  }): { id: string; entry: PtyEntry } {
    const pty = loadPty();
    const file = opts.shell ?? defaultShell();
    const args = defaultShellArgs(file);
    const env = { ...process.env, ...(opts.env ?? {}) };
    const child = pty.spawn(file, args, {
      name: 'xterm-color',
      cols: opts.cols,
      rows: opts.rows,
      cwd: opts.cwd,
      env,
      encoding: 'utf8',
    });

    const entry: PtyEntry = {
      pty: child,
      buffer: [],
      listeners: new Set(),
      exited: false,
    };
    const id = randomUUID();
    this.entries.set(id, entry);

    child.onData((data) => {
      const chunk: TerminalOutputChunk = { type: 'data', data };
      entry.buffer.push(chunk);
      for (const l of entry.listeners) l(chunk);
    });

    child.onExit((e) => {
      const chunk: TerminalOutputChunk = {
        type: 'exit',
        code: e.exitCode ?? null,
        signal: typeof e.signal === 'number' ? String(e.signal) : (e.signal ?? null),
      };
      entry.exited = true;
      entry.exitChunk = chunk;
      for (const l of entry.listeners) l(chunk);
      entry.listeners.clear();
      // Keep the entry around briefly so a late consumer still sees
      // the exit code; reap on the next spawn cycle.
      setTimeout(() => this.entries.delete(id), 30_000).unref?.();
    });

    return { id, entry };
  }

  get(id: string): PtyEntry {
    const e = this.entries.get(id);
    if (!e) throw new ApiError('not_found', 404, 'terminal not found (may have exited)');
    return e;
  }

  /**
   * Subscribe to live output, optionally with a replay of buffered chunks.
   * Returns an unsubscribe fn. The handler's `output()` AsyncIterable
   * wraps this with backpressure.
   */
  subscribe(id: string, onChunk: (c: TerminalOutputChunk) => void): () => void {
    const entry = this.get(id);
    for (const c of entry.buffer) onChunk(c);
    if (entry.exited && entry.exitChunk) {
      onChunk(entry.exitChunk);
      return () => undefined;
    }
    entry.listeners.add(onChunk);
    return () => {
      entry.listeners.delete(onChunk);
    };
  }
}

function defaultShell(): string {
  if (process.platform === 'win32') {
    return process.env.COMSPEC ?? 'powershell.exe';
  }
  return process.env.SHELL ?? '/bin/bash';
}

function defaultShellArgs(shell: string): string[] {
  if (process.platform === 'win32') {
    // PowerShell with no banner; bypass execution policy is opt-in
    // and intentionally not enabled by default.
    if (/powershell\.exe$/i.test(shell)) return ['-NoLogo'];
    if (/pwsh\.exe$/i.test(shell)) return ['-NoLogo'];
    return [];
  }
  return ['--login'];
}

export function createTerminalHandlers(deps: HandlerDeps): TerminalApi {
  const { db } = deps;
  const manager = new PtyManager();

  function resolveCwd(target: Parameters<TerminalApi['spawn']>[0]['target']): string {
    if (target.kind === 'project') {
      const project = db.getProject(target.projectId);
      if (!project) throw new ApiError('not_found', 404, 'project not found');
      return project.root_path;
    }
    if (target.kind === 'host') {
      if (process.env.MCP_HOST_TERMINAL_ENABLED !== '1') {
        throw new ApiError('host_terminal_disabled', 403, 'host terminal disabled (set MCP_HOST_TERMINAL_ENABLED=1)');
      }
      return process.cwd();
    }
    // sandbox target — delegated to legacy terminal-ws.ts until Dia 3.
    throw new ApiError('not_implemented', 501, 'sandbox target not yet served by api-handlers — use /ws/terminal');
  }

  return {
    async spawn({ target, cols = 80, rows = 24, shell, cwd: cwdOverride, env }) {
      const cwd = cwdOverride ?? resolveCwd(target);
      const { id } = manager.spawn({ shell, cwd, cols, rows, env });
      const entry = manager.get(id);
      return {
        terminalId: id,
        pid: entry.pty.pid,
        shell: shell ?? defaultShell(),
        cwd,
      };
    },

    output({ terminalId }) {
      return new TerminalOutputIterable(manager, terminalId);
    },

    async write({ terminalId, data }) {
      manager.get(terminalId).pty.write(data);
    },

    async resize({ terminalId, cols, rows }) {
      manager.get(terminalId).pty.resize(cols, rows);
    },

    async kill({ terminalId, signal }) {
      manager.get(terminalId).pty.kill(signal);
    },

    async diagnose({ target }) {
      try {
        loadPty();
      } catch (err) {
        return { ok: false, reason: err instanceof Error ? err.message : String(err) };
      }
      try {
        resolveCwd(target);
        return { ok: true };
      } catch (err) {
        if (err instanceof ApiError) return { ok: false, reason: err.message };
        throw err;
      }
    },
  };
}

/**
 * Pull-based wrapper around `PtyManager.subscribe`. Each consumer gets
 * its own queue + waiters so backpressure naturally throttles a slow
 * reader without blocking the PTY's onData callback.
 *
 * Iteration ends after the `exit` frame is delivered.
 */
class TerminalOutputIterable implements AsyncIterable<TerminalOutputChunk> {
  constructor(
    private readonly manager: PtyManager,
    private readonly terminalId: string,
  ) {}

  [Symbol.asyncIterator](): AsyncIterator<TerminalOutputChunk> {
    const queue: TerminalOutputChunk[] = [];
    const waiters: Array<(r: IteratorResult<TerminalOutputChunk>) => void> = [];
    let ended = false;

    const onChunk = (chunk: TerminalOutputChunk) => {
      if (waiters.length > 0) {
        const w = waiters.shift()!;
        w({ value: chunk, done: false });
      } else {
        queue.push(chunk);
      }
      if (chunk.type === 'exit') {
        ended = true;
        while (waiters.length > 0) {
          const w = waiters.shift()!;
          w({ value: undefined as never, done: true });
        }
      }
    };

    const unsubscribe = this.manager.subscribe(this.terminalId, onChunk);

    return {
      async next(): Promise<IteratorResult<TerminalOutputChunk>> {
        if (queue.length > 0) {
          return { value: queue.shift()!, done: false };
        }
        if (ended) return { value: undefined as never, done: true };
        return new Promise<IteratorResult<TerminalOutputChunk>>((resolve) => {
          waiters.push(resolve);
        });
      },
      async return(): Promise<IteratorResult<TerminalOutputChunk>> {
        unsubscribe();
        ended = true;
        return { value: undefined as never, done: true };
      },
    };
  }
}
