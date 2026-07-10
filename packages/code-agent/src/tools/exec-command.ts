/**
 * exec_command / write_stdin — persistent shell sessions.
 *
 * Port of OpenAI Codex's `unified_exec` (codex-rs/core/src/tools/handlers/
 * unified_exec/). Pairs two tools that share a process registry:
 *
 *   exec_command: spawn a shell command, yield after `yield_time_ms`,
 *                 return whatever has been emitted so far + the
 *                 session_id. If the process is still alive, the model
 *                 can call `write_stdin` to interact with it.
 *
 *   write_stdin:  push bytes into an existing session's stdin (or empty
 *                 string for a background poll), yield briefly, return
 *                 incremental output.
 *
 * exec_command vs the one-shot `run_command`: run_command runs a command to
 * completion (or timeout) and returns the full output — it can't keep a REPL
 * alive across model turns. exec_command holds the process open so the model
 * can carry on a multi-turn conversation with it (node REPL, python -i, psql,
 * npm init, etc.). Pass `tty: true` for a real pseudo-terminal when a command
 * gates on isatty() — this replaced the old one-shot `run_command_pty` tool.
 *
 * Two transports:
 *   - pipe (default): plain `child_process.spawn` with piped stdio.
 *     Works without native deps; sufficient for non-tty REPLs.
 *   - pty (opt-in): `node-pty`-backed for commands that need a real TTY
 *     (ncurses, prompts that gate on isatty()). Same dynamic-import dance
 *     as pty.ts — absent module returns an actionable error.
 */
import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { resolve as resolvePath, isAbsolute } from 'node:path';
import type { CoderTool, ToolContext, ToolResult } from '@mcp/code-agent/core/tool.js';
import { ok, err } from '@mcp/code-agent/core/tool.js';
import { applyRuntimeEnv, type AgentRuntimeEnv } from '@mcp/code-agent/ports/shell-port.js';

// ─── Tunables ──────────────────────────────────────────────────────

const DEFAULT_EXEC_YIELD_MS = 10_000;
const DEFAULT_WRITE_YIELD_MS = 250;
const MAX_YIELD_MS = 60_000;
const DEFAULT_MAX_OUTPUT_CHARS = 20_000;
const HARD_MAX_OUTPUT_CHARS = 200_000;
const SESSION_TTL_MS = 10 * 60 * 1000;
const MAX_OPEN_SESSIONS = 16;

// ─── Process registry ──────────────────────────────────────────────
//
// Module-level singleton — sessions outlive a tool call by design (that
// is the whole point). Sessions self-evict when their process exits, on
// idle TTL, or when the caller invokes the (private) `close` action.

type Status = 'running' | 'exited';

interface NodePtyModule {
  spawn: (
    file: string,
    args: string[] | string,
    options: {
      name?: string;
      cols?: number;
      rows?: number;
      cwd?: string;
      env?: NodeJS.ProcessEnv;
      useConpty?: boolean;
    },
  ) => NodePtyProcess;
}

interface NodePtyProcess {
  onData(cb: (data: string) => void): void;
  onExit(cb: (e: { exitCode: number; signal?: number }) => void): void;
  write(data: string): void;
  kill(signal?: string): void;
}

interface SessionRecord {
  id: string;
  cmd: string;
  cwd: string;
  mode: 'pipe' | 'pty';
  proc: ChildProcess | NodePtyProcess;
  status: Status;
  exitCode: number | null;
  /** Accumulated output that hasn't been returned to the model yet. */
  pending: string;
  /** Set when the buffer overflowed since the last read. */
  truncated: boolean;
  /** Timestamp the process was spawned at. PR 5 — surfaced by
   *  `list_sessions` so the model knows session age. */
  startedAtMs: number;
  /** Timestamp of the last interaction; used for idle TTL eviction. */
  lastTouchMs: number;
  /** Resolved when the process exits — lets yield logic short-circuit. */
  exitedPromise: Promise<void>;
  /** Trips the exitedPromise. */
  markExited: (code: number | null) => void;
  /** Cleans the process and removes from the registry. */
  dispose: (reason: string) => void;
}

const sessions = new Map<string, SessionRecord>();

let cachedPty: NodePtyModule | null | undefined = undefined;

async function loadNodePty(): Promise<NodePtyModule | null> {
  if (cachedPty !== undefined) return cachedPty;
  try {
    const specifier = 'node-pty';
    const mod = (await import(/* @vite-ignore */ specifier)) as NodePtyModule;
    cachedPty = mod;
    return mod;
  } catch {
    cachedPty = null;
    return null;
  }
}

function nowMs(): number {
  return Date.now();
}

function reapIdleSessions(): void {
  const cutoff = nowMs() - SESSION_TTL_MS;
  for (const rec of sessions.values()) {
    if (rec.lastTouchMs < cutoff) {
      rec.dispose('idle-ttl');
    }
  }
}

function enforceMaxOpen(): void {
  if (sessions.size <= MAX_OPEN_SESSIONS) return;
  // Evict the oldest idle session. Running sessions are kept if possible.
  const candidates = [...sessions.values()].sort((a, b) => a.lastTouchMs - b.lastTouchMs);
  for (const rec of candidates) {
    if (sessions.size <= MAX_OPEN_SESSIONS) break;
    if (rec.status === 'exited') {
      rec.dispose('max-open-evict-exited');
    }
  }
  // Still over? Force-kill the oldest running session.
  while (sessions.size > MAX_OPEN_SESSIONS) {
    const oldest = [...sessions.values()].sort((a, b) => a.lastTouchMs - b.lastTouchMs)[0];
    if (!oldest) break;
    oldest.dispose('max-open-evict-running');
  }
}

function appendOutput(rec: SessionRecord, chunk: string, maxChars: number): void {
  if (!chunk) return;
  rec.pending += chunk;
  if (rec.pending.length > maxChars) {
    rec.pending = rec.pending.slice(rec.pending.length - maxChars);
    rec.truncated = true;
  }
}

function drainPending(rec: SessionRecord): { output: string; truncated: boolean } {
  const output = rec.pending;
  const truncated = rec.truncated;
  rec.pending = '';
  rec.truncated = false;
  return { output, truncated };
}

function clampYield(raw: unknown, fallback: number): number {
  const n = typeof raw === 'number' && Number.isFinite(raw) ? raw : fallback;
  return Math.min(Math.max(0, n), MAX_YIELD_MS);
}

function clampMaxChars(raw: unknown): number {
  const n = typeof raw === 'number' && Number.isFinite(raw) ? raw : DEFAULT_MAX_OUTPUT_CHARS;
  return Math.min(Math.max(1_000, n), HARD_MAX_OUTPUT_CHARS);
}

function resolveWorkdir(ctx: ToolContext, raw: unknown): string {
  if (typeof raw !== 'string' || raw.length === 0) return ctx.cwd;
  return isAbsolute(raw) ? raw : resolvePath(ctx.cwd, raw);
}

function describeResult(
  rec: SessionRecord,
  drained: { output: string; truncated: boolean },
): string {
  const header = [
    `session_id=${rec.id}`,
    `status=${rec.status}`,
    rec.status === 'exited' ? `exit=${rec.exitCode ?? 'signal'}` : null,
    drained.truncated ? 'output_truncated=true' : null,
  ]
    .filter(Boolean)
    .join(' ');
  const body = drained.output || '(no new output)';
  return `${header}\n\n${body}`;
}

// Strips dev-only env vars that leak from our parent (Electron/tsx) into
// user-spawned shells. Mirrors pty.ts. Without this, `node script.js`
// inside an exec session crashes with ERR_MODULE_NOT_FOUND: 'tsx'.
function cleanEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.NODE_OPTIONS;
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.MCP_DEV_HTTP;
  delete env.MCP_ELECTRON_DEV_URL;
  return env;
}

// ─── Spawn helpers ─────────────────────────────────────────────────

async function spawnSession(opts: {
  cmd: string;
  cwd: string;
  mode: 'pipe' | 'pty';
  cols: number;
  rows: number;
  maxChars: number;
  /** Per-project PHP/Python (not Node) to put on PATH for the session. */
  runtimeEnv?: AgentRuntimeEnv;
}): Promise<SessionRecord> {
  const env = applyRuntimeEnv(cleanEnv(), opts.runtimeEnv);
  const id = randomUUID().slice(0, 8);
  let proc: ChildProcess | NodePtyProcess;
  let resolveExit!: () => void;
  const exitedPromise = new Promise<void>((res) => {
    resolveExit = res;
  });

  if (opts.mode === 'pty') {
    const pty = await loadNodePty();
    if (!pty) {
      throw new Error(
        'exec_command(tty=true) needs node-pty.\n' +
          '  Install:  npm install node-pty\n' +
          '  Or call again with tty=false (default) — pipe mode works for most REPLs.',
      );
    }
    const isElectron = !!process.versions.electron;
    const isWindows = process.platform === 'win32';
    proc = pty.spawn(process.platform === 'win32' ? 'cmd.exe' : '/bin/sh', process.platform === 'win32' ? ['/d', '/s', '/c', opts.cmd] : ['-c', opts.cmd], {
      name: 'xterm-color',
      cols: opts.cols,
      rows: opts.rows,
      cwd: opts.cwd,
      env,
      ...(isWindows && isElectron ? { useConpty: false } : {}),
    });
  } else {
    const isWindows = process.platform === 'win32';
    proc = nodeSpawn(isWindows ? 'cmd.exe' : '/bin/sh', isWindows ? ['/d', '/s', '/c', opts.cmd] : ['-c', opts.cmd], {
      cwd: opts.cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      // detached:false (default) — kill propagates to children on dispose.
    });
  }

  const rec: SessionRecord = {
    id,
    cmd: opts.cmd,
    cwd: opts.cwd,
    mode: opts.mode,
    proc,
    status: 'running',
    exitCode: null,
    pending: '',
    truncated: false,
    startedAtMs: nowMs(),
    lastTouchMs: nowMs(),
    exitedPromise,
    markExited: (code) => {
      rec.status = 'exited';
      rec.exitCode = code;
      resolveExit();
    },
    dispose: (_reason) => {
      try {
        if (opts.mode === 'pty') {
          (proc as NodePtyProcess).kill();
        } else {
          (proc as ChildProcess).kill('SIGTERM');
        }
      } catch {
        /* ignore */
      }
      if (rec.status === 'running') rec.markExited(null);
      sessions.delete(id);
    },
  };

  if (opts.mode === 'pty') {
    const ptyProc = proc as NodePtyProcess;
    ptyProc.onData((data) => {
      appendOutput(rec, data, opts.maxChars);
    });
    ptyProc.onExit(({ exitCode }) => {
      rec.markExited(exitCode);
    });
  } else {
    const childProc = proc as ChildProcess;
    childProc.stdout?.on('data', (chunk: Buffer | string) => {
      appendOutput(rec, chunk.toString(), opts.maxChars);
    });
    childProc.stderr?.on('data', (chunk: Buffer | string) => {
      // Merge stderr into the same buffer — keeps ordering relative to
      // stdout. The model rarely needs to distinguish, and a separate
      // channel would double the response shape complexity.
      appendOutput(rec, chunk.toString(), opts.maxChars);
    });
    childProc.on('exit', (code, signal) => {
      rec.markExited(code ?? (signal ? -1 : null));
    });
    childProc.on('error', (e) => {
      appendOutput(rec, `\n[spawn-error] ${e.message}\n`, opts.maxChars);
      rec.markExited(-1);
    });
  }

  sessions.set(id, rec);
  enforceMaxOpen();
  return rec;
}

function writeToSession(rec: SessionRecord, chars: string): void {
  if (!chars) return;
  if (rec.mode === 'pty') {
    (rec.proc as NodePtyProcess).write(chars);
  } else {
    const stdin = (rec.proc as ChildProcess).stdin;
    if (stdin && !stdin.destroyed) stdin.write(chars);
  }
}

async function awaitYield(rec: SessionRecord, yieldMs: number, signal?: AbortSignal): Promise<void> {
  if (yieldMs <= 0) return;
  await Promise.race([
    rec.exitedPromise,
    new Promise<void>((res) => {
      const t = setTimeout(res, yieldMs);
      if (signal) {
        const onAbort = () => {
          clearTimeout(t);
          res();
        };
        if (signal.aborted) onAbort();
        else signal.addEventListener('abort', onAbort, { once: true });
      }
    }),
  ]);
}

// ─── Tool: exec_command ────────────────────────────────────────────

const EXEC_COMMAND_DESC =
  'Spawn a shell command as a PERSISTENT session and return whatever it emits within a short yield window. ' +
  'If the process is still alive when yield expires, you get back a `session_id` you can drive with `write_stdin`.\n' +
  '\n' +
  'USE: when the command needs to interact across multiple turns — REPLs (`node`, `python -i`, `psql`), ' +
  'interactive scaffolders (`npm init`, `gh auth login`), TUI commands that prompt for choices.\n' +
  'USE: when you need to send several lines of stdin separated by reading responses.\n' +
  "DON'T: use as a replacement for `run_command` — one-shot commands are cheaper there. " +
  "exec_command holds resources open until you `write_stdin({chars:''})` to confirm exit or the TTL reaps it.\n" +
  "DON'T: spawn long-running servers (`npm run dev`, watch modes) here — the session will be evicted after " +
  '10 min of model inactivity even if the server is healthy. Use a background terminal for those.\n' +
  'An evicted session is GONE (process killed, no reconnect) — call `list_sessions` to check which session_ids are still alive before writing to one.\n' +
  "The shell is the platform default (cmd.exe on Windows, /bin/sh on POSIX) — see the system prompt's OS line for shell-specific dos/don'ts.\n" +
  '\n' +
  `Defaults: tty=false (pipe); yields after ~${DEFAULT_EXEC_YIELD_MS}ms; output capped at ~${DEFAULT_MAX_OUTPUT_CHARS} chars. ` +
  `Output beyond cap is FIFO-truncated; \`output_truncated=true\` in the header signals when this happened.`;

export const execCommand: CoderTool = {
  name: 'exec_command',
  description: EXEC_COMMAND_DESC,
  source: 'native',
  mutates: true,
  parallelSafe: false,
  riskLevel: 'execute',
  parameters: {
    type: 'object',
    properties: {
      cmd: {
        type: 'string',
        description: 'Shell command line. Passed to /bin/sh -c (or cmd.exe /c on Windows).',
      },
      workdir: {
        type: 'string',
        description: 'Working directory. Relative paths resolve against the project root. Default: project root.',
      },
      tty: {
        type: 'boolean',
        description: 'Force a real pty (node-pty). Use only when the command gates on isatty(). Default false (pipe).',
      },
    },
    required: ['cmd'],
    additionalProperties: false,
  },
  handler: async (args, ctx: ToolContext): Promise<ToolResult> => {
    reapIdleSessions();
    const cmd = String(args.cmd ?? '').trim();
    if (!cmd) return err('exec_command: cmd cannot be empty');

    const cwd = resolveWorkdir(ctx, args.workdir);
    const mode: 'pipe' | 'pty' = args.tty === true ? 'pty' : 'pipe';
    const yieldMs = clampYield(args.yield_time_ms, DEFAULT_EXEC_YIELD_MS);
    const maxChars = clampMaxChars(args.max_output_tokens);
    const cols = typeof args.cols === 'number' && Number.isFinite(args.cols) ? args.cols : 120;
    const rows = typeof args.rows === 'number' && Number.isFinite(args.rows) ? args.rows : 30;

    let rec: SessionRecord;
    try {
      rec = await spawnSession({ cmd, cwd, mode, cols, rows, maxChars, runtimeEnv: ctx.runtimeEnv });
    } catch (e) {
      return err(`exec_command: spawn failed — ${e instanceof Error ? e.message : String(e)}`);
    }

    // Surface abort to the session.
    const onAbort = () => rec.dispose('runner-abort');
    if (ctx.signal) {
      if (ctx.signal.aborted) onAbort();
      else ctx.signal.addEventListener('abort', onAbort, { once: true });
    }

    await awaitYield(rec, yieldMs, ctx.signal);
    rec.lastTouchMs = nowMs();
    const drained = drainPending(rec);

    if (rec.status === 'exited') {
      // Process completed within the yield window — clean up the registry
      // entry so the model doesn't try to write_stdin into a corpse.
      sessions.delete(rec.id);
    }

    return ok(describeResult(rec, drained));
  },
};

// ─── Tool: write_stdin ─────────────────────────────────────────────

const WRITE_STDIN_DESC =
  'Send bytes to an exec_command session\'s stdin, then yield briefly to collect new output. ' +
  'Use `chars=""` (default) as a non-destructive poll to check whether the session is still alive ' +
  'and pick up output emitted since the last read.\n' +
  '\n' +
  'USE: after `exec_command` returned with status=running and you have an answer/command to push.\n' +
  'USE: with empty chars to poll a session that needs more time to produce its prompt.\n' +
  "DON'T: forget the trailing newline if the REPL expects line-buffered input — pass `chars: '5+5\\n'`, " +
  "not `'5+5'`. The tool does NOT auto-append newlines.\n" +
  "DON'T: call after `status=exited` — the session_id has been reaped. exec_command a new session.";

/**
 * PR 5 — formatted age helper used by `list_sessions` and the rich
 * `write_stdin` error payload. Returns "5s", "3m", "1h2m" style.
 */
function formatAgeMs(ms: number): string {
  if (ms < 1_000) return `${ms}ms`;
  const totalSec = Math.floor(ms / 1_000);
  if (totalSec < 60) return `${totalSec}s`;
  const totalMin = Math.floor(totalSec / 60);
  if (totalMin < 60) return `${totalMin}m`;
  const hours = Math.floor(totalMin / 60);
  const mins = totalMin % 60;
  return mins === 0 ? `${hours}h` : `${hours}h${mins}m`;
}

/**
 * Detect a `write_stdin` misfire: the model meant to call a different tool
 * (most often `write_file`) but stuffed the tool name / a path into
 * `session_id` and the payload into `chars`. Real session ids are 8 lowercase
 * hex chars (`randomUUID().slice(0, 8)`); a `session_id` that isn't that shape
 * was never returned by `exec_command`, so retrying it (or polling
 * `list_sessions`, which is correctly empty) can never succeed. Returns a
 * redirect hint to append to the "session not active" error, or '' when the id
 * looks like a genuine (just-expired) session id.
 */
function detectMisfireHint(id: string, rawChars: unknown): string {
  if (/^[0-9a-f]{8}$/.test(id)) return ''; // genuine-shaped id → likely a real stale session
  const chars = typeof rawChars === 'string' ? rawChars : '';
  const looksLikeFile = chars.length > 80 || chars.includes('\n');
  const base =
    `MISFIRE: '${id}' is not a session_id — those are 8 hex chars (e.g. 'a1b2c3d4') ` +
    `returned by a prior \`exec_command\`. \`write_stdin\` ONLY writes to a live shell ` +
    `session's stdin; it does NOT create or edit files.`;
  const tail = looksLikeFile
    ? ` It looks like you meant to WRITE A FILE. If \`write_file\` isn't in your tools, ` +
      `first \`expand_toolset({ tier: 'navigate' })\`, then call ` +
      `\`write_file({ path, content })\` (or \`create_file\` for a new file).`
    : ` If you meant to call a different tool (e.g. \`${id}\`), call it directly — and ` +
      `\`expand_toolset({ tier: 'navigate' })\` first if it isn't visible yet.`;
  return `${base}${tail}\n\n`;
}

/**
 * PR 5 — snapshot of the live session registry. Pure read; mutates
 * nothing. Used by `list_sessions` and by the rich error payload of
 * `write_stdin` when an unknown session id is passed.
 */
interface SessionSnapshot {
  id: string;
  cmd: string;
  cwd: string;
  status: Status;
  mode: 'pipe' | 'pty';
  startedAtMs: number;
  lastTouchMs: number;
  ageStr: string;
  idleStr: string;
}

function snapshotSessions(): SessionSnapshot[] {
  const now = nowMs();
  return [...sessions.values()].map((rec) => ({
    id: rec.id,
    cmd: rec.cmd,
    cwd: rec.cwd,
    status: rec.status,
    mode: rec.mode,
    startedAtMs: rec.startedAtMs,
    lastTouchMs: rec.lastTouchMs,
    ageStr: formatAgeMs(now - rec.startedAtMs),
    idleStr: formatAgeMs(now - rec.lastTouchMs),
  })).sort((a, b) => a.startedAtMs - b.startedAtMs);
}

const LIST_SESSIONS_DESC =
  'List the active exec_command sessions in this runner (id, status, age, idle). ' +
  'Use BEFORE `write_stdin` to confirm the session you want still exists. ' +
  'Returns `(no active sessions)` when the registry is empty.\n\n' +
  'USE: when you forgot the session_id, or when write_stdin returned ' +
  '"session not active" and you want to know which ids ARE valid.\n' +
  "DON'T: poll this in a loop — sessions only change when YOU call exec_command / write_stdin.";

export const listSessions: CoderTool = {
  name: 'list_sessions',
  description: LIST_SESSIONS_DESC,
  source: 'native',
  mutates: false,
  parallelSafe: true,
  repeatPolicy: 'volatile',
  riskLevel: 'read',
  parameters: {
    type: 'object',
    properties: {},
    additionalProperties: false,
  },
  handler: async (): Promise<ToolResult> => {
    reapIdleSessions();
    const snap = snapshotSessions();
    if (snap.length === 0) {
      return ok('(no active sessions; spawn one with exec_command first)');
    }
    const lines = snap.map((s) => {
      const cmd = s.cmd.length > 60 ? s.cmd.slice(0, 57) + '...' : s.cmd;
      return `${s.id} | ${s.status} | ${s.mode} | age ${s.ageStr} | idle ${s.idleStr} | ${cmd}`;
    });
    return ok(
      `Active sessions (${snap.length}):\n` +
      `<id> | <status> | <mode> | <age since spawn> | <idle since last io> | <cmd>\n` +
      lines.join('\n'),
    );
  },
};

export const writeStdin: CoderTool = {
  name: 'write_stdin',
  description: WRITE_STDIN_DESC,
  source: 'native',
  mutates: true,
  parallelSafe: false,
  riskLevel: 'execute',
  parameters: {
    type: 'object',
    properties: {
      session_id: {
        type: 'string',
        description: 'Session id returned by a prior `exec_command`.',
      },
      chars: {
        type: 'string',
        description: 'Bytes to write to stdin (no newline auto-appended). Empty string = background poll.',
      },
      yield_time_ms: {
        type: 'number',
        description: `How long to wait for output after writing. Default ${DEFAULT_WRITE_YIELD_MS}, max ${MAX_YIELD_MS}.`,
      },
    },
    required: ['session_id'],
    additionalProperties: false,
  },
  handler: async (args, ctx: ToolContext): Promise<ToolResult> => {
    reapIdleSessions();
    const id = String(args.session_id ?? '').trim();
    if (!id) return err('write_stdin: session_id is required');
    const rec = sessions.get(id);
    if (!rec) {
      // PR 5 — rich error payload: list the IDs that ARE active so the
      // model can immediately self-correct instead of rotating
      // session_ids blindly. The failure-streak guard still escalates
      // if the model ignores the list and keeps retrying.
      const snap = snapshotSessions();
      const activeStr = snap.length === 0
        ? '  (no active sessions — use `exec_command` to spawn one)'
        : snap.map((s) =>
            `  - ${s.id} (${s.status}, ${s.mode}, age ${s.ageStr}, idle ${s.idleStr}): ` +
            (s.cmd.length > 50 ? s.cmd.slice(0, 47) + '...' : s.cmd),
          ).join('\n');
      // Lead with the misfire redirect when present: it's the actionable
      // line, and the failure-streak guard only echoes the FIRST ~200 chars
      // of the error into its refusal — so the fix must come first.
      const misfire = detectMisfireHint(id, args.chars);
      return err(
        misfire +
        `write_stdin: session '${id}' is not active (exited / reaped by idle-TTL / never existed).\n` +
        `Active sessions right now:\n${activeStr}\n` +
        `A session that exited cannot be reopened — its stdin is gone. ` +
        `Stop retrying with this id. Either:\n` +
        `  (a) call \`write_stdin\` with one of the active session_ids above;\n` +
        `  (b) spawn a fresh session via \`exec_command\`; or\n` +
        `  (c) call \`list_sessions\` first to refresh your view, then decide.`,
      );
    }

    const chars = typeof args.chars === 'string' ? args.chars : '';
    const yieldMs = clampYield(args.yield_time_ms, DEFAULT_WRITE_YIELD_MS);

    if (chars && rec.status === 'running') {
      try {
        writeToSession(rec, chars);
      } catch (e) {
        return err(`write_stdin: write failed — ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    await awaitYield(rec, yieldMs, ctx.signal);
    rec.lastTouchMs = nowMs();
    const drained = drainPending(rec);

    if (rec.status === 'exited') {
      sessions.delete(rec.id);
    }

    return ok(describeResult(rec, drained));
  },
};

// ─── Test hooks ────────────────────────────────────────────────────
// Exported only so unit tests can poke the registry. Not part of the
// stable surface; do not import from runner code.

export const __testing = {
  sessions,
  reapIdleSessions,
  disposeAll(): void {
    for (const rec of sessions.values()) rec.dispose('test-reset');
    sessions.clear();
  },
};

export const execCommandTools: CoderTool[] = [execCommand, writeStdin, listSessions];
