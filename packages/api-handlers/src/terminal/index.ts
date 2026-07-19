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
 * The PTY registry itself lives in `./pty-manager.ts` as a shared
 * singleton so the `runner` namespace can spawn package-manager scripts
 * into the same manager (and reuse `terminal.output` to stream them).
 */

import { ApiError, type TerminalApi, type TerminalOutputChunk } from '@mcp/api-bus';
import type { HandlerDeps } from '../types.js';
import { ensureDataDir } from '@mcp/shared/utils/config.js';
import { sharedPtyManager, defaultShell, loadPty, type PtyManager } from './pty-manager.js';
import { detectShells, targetForShell } from './shells.js';
import { resolveProjectRuntimeEnv } from '../runtime/runtime-resolve.js';

export function createTerminalHandlers(deps: HandlerDeps): TerminalApi {
  const { db } = deps;
  const manager = sharedPtyManager;

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
    async spawn({ target, cols = 80, rows = 24, shell, shellArgs, cwd: cwdOverride, env }) {
      const cwd = cwdOverride ?? resolveCwd(target);
      // Per-project runtimes (Node/PHP/Python) → prepend their bin dirs to PATH
      // (and add e.g. PHPRC) so the terminal uses the same toolchains as the
      // runner. The chosen shell decides the target: a WSL distro gets its Linux
      // managed runtimes on the POSIX PATH (posix*), the rest the Windows ones.
      const runtimeTarget = targetForShell({ file: shell ?? '', args: shellArgs });
      const { pathPrepend, extraEnv, posixPathPrepend, posixExtraEnv } =
        target.kind === 'project'
          ? resolveProjectRuntimeEnv(db, target.projectId, ensureDataDir(), { target: runtimeTarget })
          : { pathPrepend: [], extraEnv: {}, posixPathPrepend: [], posixExtraEnv: {} };
      const { id } = manager.spawn({ shell, shellArgs, cwd, cols, rows, env, pathPrepend, extraEnv, posixPathPrepend, posixExtraEnv });
      const entry = manager.get(id);
      return {
        terminalId: id,
        pid: entry.pty.pid,
        shell: shell ?? defaultShell(),
        cwd,
      };
    },

    async listShells() {
      return detectShells();
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
      manager.kill(terminalId, signal);
    },

    async diagnose({ target }) {
      try {
        // Touch the lazy node-pty load — surfaces platform issues early.
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
