/**
 * Shared PTY registry — a single in-process manager of live node-pty
 * instances, used by BOTH the `terminal` namespace (interactive shells)
 * AND the `runner` namespace (package-manager scripts run as one-shot
 * commands). Keeping ONE manager means `terminal.output(terminalId)`
 * transparently streams runner PTYs too, and processes survive renderer
 * navigation because they live in the main process.
 *
 * node-pty is loaded lazily via `createRequire` so a missing prebuild on
 * exotic platforms degrades to a clean ApiError instead of failing
 * module load.
 */

import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { delimiter } from 'node:path';
import { ApiError, type TerminalOutputChunk } from '@mcp/api-bus';

export interface IPty {
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
      /** Windows-only — force WinPTY backend under Electron (see below). */
      useConpty?: boolean;
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

export { loadPty };

/**
 * In-process registry of live PTYs. Keyed by the opaque `terminalId`
 * returned from `spawn`. A buffered fan-out per terminal lets multiple
 * consumers attach (Electron renderer + later debug viewer, e.g.).
 */
export interface PtyEntry {
  pty: IPty;
  buffer: TerminalOutputChunk[];
  listeners: Set<(chunk: TerminalOutputChunk) => void>;
  exited: boolean;
  exitChunk?: TerminalOutputChunk;
  /** One-shot exit callbacks (runner status tracking) — no buffer replay. */
  exitHooks: Set<(code: number | null) => void>;
}

export class PtyManager {
  private readonly entries = new Map<string, PtyEntry>();

  spawn(opts: {
    shell?: string;
    /**
     * Explicit argv for the interactive shell. Needed for shells whose
     * launch args can't be inferred from the executable — `wsl.exe -d
     * <distro>`, Git Bash's `-i -l`. Ignored when `command` is set
     * (that path builds its own invocation). Falls back to
     * `defaultShellArgs(shell)`.
     */
    shellArgs?: string[];
    cwd: string;
    cols: number;
    rows: number;
    env?: Record<string, string>;
    /**
     * When set, the PTY runs this command and exits (instead of an
     * interactive shell). Used by the runner to launch `npm run dev`
     * etc. with a clean exit code.
     */
    command?: string;
    /**
     * When set, prepended to PATH so this process (and its children) use a
     * specific Node toolchain. Drives the per-project Node version — the
     * project terminal and the runner both pass the resolved bin dir.
     */
    nodeBinDir?: string;
  }): { id: string; entry: PtyEntry } {
    const pty = loadPty();
    const shell = opts.shell ?? defaultShell();
    const { file, args } = opts.command
      ? commandInvocation(shell, opts.command)
      : { file: shell, args: opts.shellArgs ?? defaultShellArgs(shell) };
    // Build a CLEAN env for the user's process — strip the dev-only
    // vars our parent process sets (NODE_OPTIONS injects tsx/esm,
    // ELECTRON_RUN_AS_NODE flags the electron binary as a Node interpreter,
    // MCP_* are internal flags). Leaking these breaks every `npm run dev`
    // / `node script.js` because the project's node_modules doesn't have
    // tsx, and the shell's `node` doesn't expect ELECTRON_RUN_AS_NODE.
    const baseEnv: Record<string, string | undefined> = { ...process.env };
    delete baseEnv.NODE_OPTIONS;
    delete baseEnv.ELECTRON_RUN_AS_NODE;
    delete baseEnv.MCP_DEV_HTTP;
    delete baseEnv.MCP_ELECTRON_DEV_URL;
    const env = { ...baseEnv, ...(opts.env ?? {}) };
    // Per-project Node: put the chosen toolchain first on PATH so `node`,
    // `npm`, `npx` resolve to it ahead of the system install. Windows env
    // keys are case-insensitive but the object may carry `Path` rather
    // than `PATH`; normalise to `PATH` and drop the stale `Path`.
    if (opts.nodeBinDir) {
      const prev = env.PATH ?? env.Path ?? '';
      delete env.Path;
      env.PATH = `${opts.nodeBinDir}${delimiter}${prev}`;
    }
    // Force WinPTY backend on Windows-under-Electron. ConPTY's
    // `conpty_console_list_agent` helper spawns a child of
    // `process.execPath` and calls AttachConsole on the parent's
    // console; Electron is GUI-subsystem and has no console attached,
    // so the helper crashes with "AttachConsole failed" and tears down
    // the renderer. WinPTY uses a dedicated agent binary instead.
    const inElectron = !!process.versions.electron;
    const isWindows = process.platform === 'win32';
    const child = pty.spawn(file, args, {
      name: 'xterm-color',
      cols: opts.cols,
      rows: opts.rows,
      cwd: opts.cwd,
      env,
      encoding: 'utf8',
      ...(isWindows && inElectron ? { useConpty: false } : {}),
    });

    const entry: PtyEntry = {
      pty: child,
      buffer: [],
      listeners: new Set(),
      exited: false,
      exitHooks: new Set(),
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
      for (const h of entry.exitHooks) h(e.exitCode ?? null);
      entry.exitHooks.clear();
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
   * Subscribe to live output, replaying buffered chunks first. Returns an
   * unsubscribe fn. The handler's `output()` AsyncIterable wraps this with
   * backpressure.
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

  /**
   * Register a one-shot exit callback WITHOUT replaying the output buffer.
   * Used by the runner to flip task status when a long-running command
   * ends, without paying the cost of streaming all its output. If the PTY
   * has already exited, fires synchronously. Returns an unregister fn.
   */
  onExit(id: string, cb: (code: number | null) => void): () => void {
    const entry = this.entries.get(id);
    if (!entry) {
      cb(null);
      return () => undefined;
    }
    if (entry.exited) {
      cb(entry.exitChunk?.type === 'exit' ? (entry.exitChunk.code ?? null) : null);
      return () => undefined;
    }
    entry.exitHooks.add(cb);
    return () => {
      entry.exitHooks.delete(cb);
    };
  }
}

export function defaultShell(): string {
  if (process.platform === 'win32') {
    return process.env.COMSPEC ?? 'powershell.exe';
  }
  return process.env.SHELL ?? '/bin/bash';
}

export function defaultShellArgs(shell: string): string[] {
  if (process.platform === 'win32') {
    // PowerShell with no banner; bypass execution policy is opt-in
    // and intentionally not enabled by default.
    if (/powershell\.exe$/i.test(shell)) return ['-NoLogo'];
    if (/pwsh\.exe$/i.test(shell)) return ['-NoLogo'];
    return [];
  }
  return ['--login'];
}

/**
 * Build the `{file, args}` that runs a single command string to completion
 * inside `shell`, so the PTY exits (with the command's code) when the
 * command finishes — giving the runner a clear running→exited transition.
 */
function commandInvocation(shell: string, command: string): { file: string; args: string[] } {
  if (process.platform === 'win32') {
    if (/powershell\.exe$/i.test(shell) || /pwsh(\.exe)?$/i.test(shell)) {
      return { file: shell, args: ['-NoLogo', '-NoProfile', '-Command', command] };
    }
    // cmd.exe — /d skip AutoRun, /s preserve quotes, /c run-and-exit.
    return { file: shell, args: ['/d', '/s', '/c', command] };
  }
  // POSIX shells — login shell so the user's PATH/nvm/etc. are present.
  return { file: shell, args: ['-lc', command] };
}

/** Shared singleton — imported by both terminal and runner handlers. */
export const sharedPtyManager = new PtyManager();
