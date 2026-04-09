import type { CoderTool, ToolContext, ToolResult } from '../core/tool.js';
import { ok, err } from '../core/tool.js';

/**
 * run_command_pty — shell execution with a real pseudo-terminal.
 *
 * Motivation: plain `run_command` uses `child_process.spawn` with piped
 * stdio, which means commands expecting a TTY (interactive REPLs, ncurses
 * UIs, commands that emit colored output only when isatty()) either hang
 * or degrade. A real pty gives them what they want.
 *
 * Implementation note: we DO NOT add `node-pty` to package.json because it's
 * a native module requiring platform-specific build tools. Instead, this
 * tool dynamically imports it at first use; if absent, it returns an
 * actionable error telling the user to `npm install node-pty` — no broken
 * default install.
 *
 * Scope: designed for short interactive bursts. A hard timeout + max output
 * cap prevent a rogue REPL from hanging the session or flooding the history.
 * For long-running servers (`npm run dev`), do NOT use this — use a
 * background shell from the user's terminal.
 */

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 300_000;
const MAX_OUTPUT_CHARS = 20_000;

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
    },
  ) => NodePtyProcess;
}

interface NodePtyProcess {
  onData(cb: (data: string) => void): void;
  onExit(cb: (e: { exitCode: number; signal?: number }) => void): void;
  write(data: string): void;
  kill(signal?: string): void;
}

let cachedModule: NodePtyModule | null | undefined = undefined;

async function loadNodePty(): Promise<NodePtyModule | null> {
  if (cachedModule !== undefined) return cachedModule;
  try {
    // Use a dynamic specifier built at runtime so static analyzers (and
    // tsc's module resolver) don't try to resolve node-pty at compile time.
    const specifier = 'node-pty';
    const mod = (await import(/* @vite-ignore */ specifier)) as NodePtyModule;
    cachedModule = mod;
    return mod;
  } catch {
    cachedModule = null;
    return null;
  }
}

export const runCommandPty: CoderTool = {
  name: 'run_command_pty',
  description:
    'Execute a shell command inside a real pseudo-terminal. Optional stdin lines for interactive prompts.\n' +
    "USE: commands that require a TTY (REPLs, ncurses UIs, commands that gate colored/formatted output behind isatty).\n" +
    "USE: short interactive bursts where you need to send a few answers to prompts.\n" +
    "DON'T: use as a replacement for run_command — plain run_command is cheaper and cacheable.\n" +
    "DON'T: use for long-running servers (npm run dev, watch modes). The timeout will kill them and you'll have wasted tokens.\n" +
    "DON'T: assume node-pty is installed — this tool returns an error with install instructions if the native module is missing.\n" +
    `Default timeout ${DEFAULT_TIMEOUT_MS / 1000}s, max output ${MAX_OUTPUT_CHARS} chars. Output beyond the cap is dropped.`,
  source: 'native',
  parameters: {
    type: 'object',
    properties: {
      command: {
        type: 'string',
        description: 'The command to run (e.g. "node", "python3"). Pass args separately.',
      },
      args: {
        type: 'array',
        items: { type: 'string' },
        description: 'Command arguments as an array.',
      },
      stdin: {
        type: 'array',
        items: { type: 'string' },
        description:
          "Lines to feed to stdin after the process starts. Each is sent with a trailing newline. Use for answering prompts (e.g. ['yes', '42']).",
      },
      timeout_ms: {
        type: 'number',
        description: `Hard timeout in milliseconds. Default ${DEFAULT_TIMEOUT_MS}, max ${MAX_TIMEOUT_MS}.`,
      },
      cols: { type: 'number', description: 'Terminal columns (default 120).' },
      rows: { type: 'number', description: 'Terminal rows (default 30).' },
    },
    required: ['command'],
    additionalProperties: false,
  },
  handler: async (args, ctx: ToolContext): Promise<ToolResult> => {
    const command = String(args.command ?? '').trim();
    if (!command) return err('command cannot be empty');

    const pty = await loadNodePty();
    if (!pty) {
      return err(
        'node-pty is not installed in this project.\n' +
          'To enable run_command_pty, install it:\n' +
          '  npm install node-pty\n' +
          'It is an optional native dependency — regular run_command keeps working without it.',
      );
    }

    const argv = Array.isArray(args.args) ? args.args.map(String) : [];
    const stdinLines = Array.isArray(args.stdin) ? args.stdin.map(String) : [];
    const timeoutMs = Math.min(
      Math.max(1_000, Number(args.timeout_ms) || DEFAULT_TIMEOUT_MS),
      MAX_TIMEOUT_MS,
    );
    const cols = Number.isFinite(Number(args.cols)) ? Number(args.cols) : 120;
    const rows = Number.isFinite(Number(args.rows)) ? Number(args.rows) : 30;

    return new Promise<ToolResult>((resolve) => {
      let proc: NodePtyProcess | null = null;
      let output = '';
      let timedOut = false;
      let truncated = false;
      let settled = false;

      const finish = (exitCode: number | null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        const header = [
          `exit=${exitCode ?? 'signal'}`,
          timedOut ? 'timed_out=true' : null,
          truncated ? 'output_truncated=true' : null,
        ]
          .filter(Boolean)
          .join(' ');
        const body = output || '(no output)';
        resolve(ok(`${header}\n\n${body}`));
      };

      try {
        proc = pty.spawn(command, argv, {
          name: 'xterm-color',
          cols,
          rows,
          cwd: ctx.cwd,
          env: process.env,
        });
      } catch (e) {
        resolve(err(`run_command_pty failed to spawn: ${e instanceof Error ? e.message : String(e)}`));
        return;
      }

      const timer = setTimeout(() => {
        timedOut = true;
        try {
          proc?.kill('SIGKILL');
        } catch {
          /* ignore */
        }
        finish(null);
      }, timeoutMs);

      proc.onData((data) => {
        if (output.length + data.length > MAX_OUTPUT_CHARS) {
          output += data.slice(0, Math.max(0, MAX_OUTPUT_CHARS - output.length));
          truncated = true;
          try {
            proc?.kill('SIGKILL');
          } catch {
            /* ignore */
          }
          finish(null);
        } else {
          output += data;
        }
      });

      proc.onExit(({ exitCode }) => {
        finish(exitCode);
      });

      // Stream stdin lines into the pty. Small delay between lines so the
      // child process has a chance to print its prompt before the next line
      // lands — otherwise fast-moving REPLs drop answers.
      if (stdinLines.length > 0) {
        let i = 0;
        const sendNext = () => {
          if (settled || i >= stdinLines.length) return;
          try {
            proc?.write(stdinLines[i] + '\r');
          } catch {
            /* ignore */
          }
          i++;
          setTimeout(sendNext, 50);
        };
        setTimeout(sendNext, 100);
      }

      // Abort signal handling — kill the pty if the runner aborts.
      ctx.signal?.addEventListener(
        'abort',
        () => {
          if (!settled) {
            try {
              proc?.kill('SIGKILL');
            } catch {
              /* ignore */
            }
            finish(null);
          }
        },
        { once: true },
      );
    });
  },
};

export const ptyTools: CoderTool[] = [runCommandPty];
