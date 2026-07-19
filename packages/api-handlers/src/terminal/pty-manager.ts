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
import { killProcessTree } from '@mcp/shared/utils/process-tree.js';
import { OutputCoalescer, trimReplayBuffer } from './output-coalescer.js';
import { shValue } from './shell-quote.js';

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
  /** Running byte total of `data` chunks in `buffer` — drives replay trimming. */
  bufferBytes: number;
  listeners: Set<(chunk: TerminalOutputChunk) => void>;
  exited: boolean;
  exitChunk?: TerminalOutputChunk;
  /** One-shot exit callbacks (runner status tracking) — no buffer replay. */
  exitHooks: Set<(code: number | null) => void>;
  /** Releases native/EventEmitter subscriptions and retained buffers. */
  dispose?: () => void;
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
     * Dirs prepended to PATH (highest priority first) so this process and its
     * children use the project's chosen toolchains. Drives the per-project
     * Node/PHP/Python versions — the project terminal and runner pass the
     * resolved bin dirs from `resolveProjectRuntimeEnv`.
     */
    pathPrepend?: string[];
    /** Extra env merged after the base env (e.g. PHPRC for a managed PHP). */
    extraEnv?: Record<string, string>;
    /**
     * Dirs prepended to the distro's POSIX PATH for a WSL shell — woven into the
     * `bash -lc 'export PATH="…:$PATH"; <cmd>'` invocation (NOT the Windows env,
     * which WSL ignores). Inert for non-WSL shells.
     */
    posixPathPrepend?: string[];
    /** Extra env exported inside the distro before the command (WSL only). */
    posixExtraEnv?: Record<string, string>;
  }): { id: string; entry: PtyEntry } {
    const pty = loadPty();
    const shell = opts.shell ?? defaultShell();
    const posix = { prepend: opts.posixPathPrepend ?? [], env: opts.posixExtraEnv ?? {} };
    const { file, args } = opts.command
      ? commandInvocation(shell, opts.shellArgs, opts.command, posix)
      : interactiveInvocation(shell, opts.shellArgs, posix);
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
    const env = { ...baseEnv, ...(opts.env ?? {}), ...(opts.extraEnv ?? {}) };
    // Per-project runtimes: put the chosen toolchains first on PATH so
    // `node`/`npm`, `php`, `python`/`pip` resolve to them ahead of the system
    // install. Windows env keys are case-insensitive but the object may carry
    // `Path` rather than `PATH`; normalise to `PATH` and drop the stale `Path`.
    const prepend = (opts.pathPrepend ?? []).filter(Boolean);
    if (prepend.length > 0) {
      const prev = env.PATH ?? env.Path ?? '';
      delete env.Path;
      env.PATH = `${prepend.join(delimiter)}${delimiter}${prev}`;
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

    return this.register(child);
  }

  /**
   * Wire an `IPty` into the registry: build its buffered fan-out entry, attach
   * the output coalescer + exit handling, and return its opaque id. The
   * one place that knows how a live PTY becomes a streamable `PtyEntry`, so
   * both `spawn` (node-pty) and `registerExternalPty` (e.g. an SSH channel)
   * share identical buffering/exit/reap semantics.
   */
  private register(child: IPty): { id: string; entry: PtyEntry } {
    const entry: PtyEntry = {
      pty: child,
      buffer: [],
      bufferBytes: 0,
      listeners: new Set(),
      exited: false,
      exitHooks: new Set(),
    };
    const id = randomUUID();
    this.entries.set(id, entry);

    // Coalesce the stdout firehose: consecutive `data` chunks within a short
    // window become ONE buffered chunk + ONE fan-out, instead of one IPC
    // message per node-pty write. The replay buffer is trimmed to a byte cap
    // so re-attaching to a long-lived runner stays cheap.
    const coalescer = new OutputCoalescer((chunk) => {
      entry.buffer.push(chunk);
      if (chunk.type === 'data') entry.bufferBytes += chunk.data.length;
      entry.bufferBytes = trimReplayBuffer(entry.buffer, entry.bufferBytes);
      for (const l of entry.listeners) l(chunk);
    });
    const dataSub = child.onData((data) => coalescer.push(data));

    let reapTimer: ReturnType<typeof setTimeout> | null = null;
    let exitSub: { dispose(): void } = { dispose: () => undefined };
    exitSub = child.onExit((e) => {
      // Drain any buffered output BEFORE the exit chunk so ordering holds.
      coalescer.flush();
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
      dataSub.dispose();
      exitSub.dispose();
      // Keep the entry around briefly so a late consumer still sees
      // the exit code; reap on the next spawn cycle.
      reapTimer = setTimeout(() => {
        this.entries.delete(id);
        entry.buffer.length = 0;
        entry.exitChunk = undefined;
      }, 30_000);
      reapTimer.unref?.();
    });
    entry.dispose = () => {
      dataSub.dispose();
      exitSub.dispose();
      if (reapTimer) clearTimeout(reapTimer);
      reapTimer = null;
      coalescer.flush();
      entry.listeners.clear();
      entry.exitHooks.clear();
      entry.buffer.length = 0;
      entry.bufferBytes = 0;
      entry.exitChunk = undefined;
    };

    return { id, entry };
  }

  /**
   * Register an already-built `IPty` that did NOT come from node-pty — e.g. an
   * SSH shell channel adapted to the `IPty` interface. Once registered it is
   * indistinguishable from a local PTY: `terminal.output(id)` streams it, the
   * session store tracks it, and closing the tab kills it. The adapter is
   * responsible for mapping its transport (channel data/close/resize) onto the
   * `IPty` surface; this just plugs it into the shared buffered fan-out.
   */
  registerExternalPty(pty: IPty): { id: string; entry: PtyEntry } {
    return this.register(pty);
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

  /** Kill a terminal and every process it launched. */
  kill(id: string, signal?: string): void {
    const entry = this.get(id);
    const pid = entry.pty.pid;
    // Tree-first is intentional: once the shell exits, Windows can no longer
    // discover descendants by walking the vanished parent pid.
    killProcessTree(pid, signal === 'SIGTERM' ? 'SIGTERM' : 'SIGKILL');
    try {
      entry.pty.kill(signal);
    } catch {
      /* already exited */
    }
  }

  /**
   * OS pids of every live PTY — read BEFORE `killAll()` so the caller can
   * process-tree-kill (taskkill /T) any grandchildren the PTY launched
   * (e.g. a `npm run dev` → vite). node-pty's own `kill()` only reaps the
   * direct shell, not the dev server it spawned.
   */
  listPids(): number[] {
    const pids: number[] = [];
    for (const entry of this.entries.values()) {
      const pid = entry.pty.pid;
      if (typeof pid === 'number' && pid > 0) pids.push(pid);
    }
    return pids;
  }

  /**
   * Kill every live PTY (app shutdown). Best-effort — signals each child and
   * clears the registry so a second call is a no-op. Process trees are killed
   * here so every host (Electron and standalone HTTP) gets identical cleanup.
   */
  killAll(): void {
    for (const entry of this.entries.values()) {
      killProcessTree(entry.pty.pid);
      try {
        entry.pty.kill();
      } catch {
        /* already exited */
      }
      entry.dispose?.();
    }
    this.entries.clear();
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
 *
 * Dispatches on the shell's basename (not the host platform) so the runner
 * honours a per-project shell choice — Git Bash on Windows runs `-lc`, a
 * WSL distro runs the command inside that distro, etc. `shellArgs` carries
 * the interactive launch args (e.g. WSL's `-d <distro>`) so we can prefix
 * them before the command.
 */
/**
 * Build the `export …; ` prefix that injects a WSL distro's MCP-managed
 * runtimes BEFORE the command runs — inside the login shell so it wins over
 * the distro default. PATH dirs stay in double quotes so `$HOME` expands.
 */
export function posixExportPrefix(prepend: string[], env: Record<string, string>): string {
  const parts = Object.entries(env).map(([k, v]) => {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) throw new Error(`invalid POSIX env key: ${k}`);
    return `export ${k}=${shValue(v)}`;
  });
  if (prepend.length > 0) parts.push(`export PATH=${prepend.map(shValue).join(':')}:"$PATH"`);
  return parts.length > 0 ? `${parts.join('; ')}; ` : '';
}

/** Build the invocation for an interactive terminal, including WSL runtimes. */
export function interactiveInvocation(
  shell: string,
  shellArgs: string[] | undefined,
  posix: { prepend: string[]; env: Record<string, string> } = { prepend: [], env: {} },
): { file: string; args: string[] } {
  if (/wsl(\.exe)?$/i.test(shell) && (posix.prepend.length > 0 || Object.keys(posix.env).length > 0)) {
    const cmd = `${posixExportPrefix(posix.prepend, posix.env)}exec "\${SHELL:-/bin/bash}" -il`;
    return { file: shell, args: [...(shellArgs ?? []), '--', 'bash', '-lc', cmd] };
  }
  return { file: shell, args: shellArgs ?? defaultShellArgs(shell) };
}

export function commandInvocation(
  shell: string,
  shellArgs: string[] | undefined,
  command: string,
  posix: { prepend: string[]; env: Record<string, string> } = { prepend: [], env: {} },
): { file: string; args: string[] | string } {
  const base = shell.toLowerCase();
  // PowerShell / PowerShell 7.
  if (/(powershell|pwsh)(\.exe)?$/.test(base)) {
    return { file: shell, args: ['-NoLogo', '-NoProfile', '-Command', command] };
  }
  // cmd.exe — /d skips AutoRun, /s preserves quotes, /c runs-and-exits.
  //
  // IMPORTANT: node-pty accepts either argv[] or an already escaped Windows
  // command line. Its argv[] path serialises values with the C/C++
  // CommandLineToArgvW rules, but cmd.exe does NOT parse those rules. Passing
  // `['/c', 'php "file.php"']` therefore turns the quotes around file.php into
  // literal bytes on Windows (PHP reports `Could not open input file:
  // "file.php"`). The string form is appended verbatim by node-pty, leaving
  // cmd.exe to parse the command with its own grammar.
  if (/cmd(\.exe)?$/.test(base)) {
    return { file: shell, args: `/d /s /c ${command}` };
  }
  // WSL — run inside the selected distro's shell. `--` ends wsl's own options;
  // we invoke bash -lc so PATH/profile load, then prepend the project's chosen
  // distro-managed runtimes so they win over the distro default.
  if (/wsl(\.exe)?$/.test(base)) {
    const cmd = posixExportPrefix(posix.prepend, posix.env) + command;
    return { file: shell, args: [...(shellArgs ?? []), '--', 'bash', '-lc', cmd] };
  }
  // POSIX-style shells (bash/zsh/sh/dash, incl. Git Bash on Windows) —
  // login shell so the user's PATH/nvm/etc. are present.
  return { file: shell, args: ['-lc', command] };
}

/** Shared singleton — imported by both terminal and runner handlers. */
export const sharedPtyManager = new PtyManager();
