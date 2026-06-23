/**
 * Podman machine lifecycle for the first-run wizard.
 *
 * Windows/macOS run Podman inside a managed VM ("machine"); Linux runs it
 * natively. Reuses `runHostCommand` — the same streamed, abortable,
 * timeout-bounded host spawner the New Project wizard uses — so we inherit
 * its win32 `.cmd` handling, stderr-tail capture, and signal wiring.
 *
 * The emit-callback shape (not an async generator) mirrors
 * `runScaffoldStream(deps, input, emit)` so the api-handlers layer can wrap it
 * with the existing `streamFromCallbacks` bridge with zero new plumbing.
 */
import { defaultLocalShellPort } from '@mcp/code-agent/ports/shell-port.js';
import type { IShellPort } from '@mcp/code-agent/ports/shell-port.js';
import { runHostCommand } from '../host-scaffold/run-host-command.js';

export interface MachineInfo {
  Name?: string;
  Running?: boolean;
  [k: string]: unknown;
}

export type MachineProgress =
  | { kind: 'phase'; phase: 'init' | 'start' | 'skip'; label: string }
  | { kind: 'log'; stream: 'stdout' | 'stderr'; chunk: string }
  | { kind: 'done' }
  | { kind: 'error'; message: string; stderrTail?: string };

export type MachineSetupEmit = (ev: MachineProgress) => void;

export interface EnsureMachineOptions {
  shell?: IShellPort;
  platform?: NodeJS.Platform;
  signal?: AbortSignal;
}

const INIT_TIMEOUT_MS = 10 * 60_000;
const START_TIMEOUT_MS = 5 * 60_000;

/** `podman machine list --format json`, tolerating version drift (JSON → text). */
export async function listMachines(shell: IShellPort): Promise<MachineInfo[]> {
  try {
    const r = await shell.run('podman', ['machine', 'list', '--format', 'json'], {
      cwd: process.cwd(),
      encoding: 'utf-8',
    });
    const text = (r.stdout || '').trim();
    if (text.startsWith('[')) {
      const arr = JSON.parse(text) as MachineInfo[];
      return Array.isArray(arr) ? arr : [];
    }
    if (!text) return [];
    // Fallback: plain-text table — skip the header row, read name + "Running".
    return text
      .split(/\r?\n/)
      .slice(1)
      .filter(Boolean)
      .map((line) => ({
        Name: (line.split(/\s+/)[0] ?? '').replace(/\*$/, ''),
        Running: /running/i.test(line),
      }));
  } catch {
    return [];
  }
}

/**
 * Ensure a running Podman machine, streaming progress via `emit`. Linux is a
 * no-op. Idempotent: skips `init` when a machine already exists; `start` on an
 * already-running machine exits non-zero with "already running" — treated as
 * success. Never throws — failures are emitted as `{ kind: 'error' }`.
 */
export async function runMachineSetup(
  emit: MachineSetupEmit,
  opts: EnsureMachineOptions = {},
): Promise<void> {
  const platform = opts.platform ?? process.platform;
  if (platform === 'linux') {
    emit({ kind: 'phase', phase: 'skip', label: 'Linux runs Podman natively — no machine needed.' });
    emit({ kind: 'done' });
    return;
  }

  const shell = opts.shell ?? defaultLocalShellPort();
  const machines = await listMachines(shell);

  if (machines.length === 0) {
    emit({ kind: 'phase', phase: 'init', label: 'Creating the Podman machine (downloads a VM image)…' });
    const init = await runHostCommand({
      program: 'podman',
      args: ['machine', 'init'],
      cwd: process.cwd(),
      timeoutMs: INIT_TIMEOUT_MS,
      signal: opts.signal,
      onLog: (stream, chunk) => emit({ kind: 'log', stream, chunk }),
    });
    if (!init.ok) {
      emit({ kind: 'error', message: 'Failed to create the Podman machine.', stderrTail: init.stderrTail });
      return;
    }
  }

  emit({ kind: 'phase', phase: 'start', label: 'Starting the Podman machine…' });
  const start = await runHostCommand({
    program: 'podman',
    args: ['machine', 'start'],
    cwd: process.cwd(),
    timeoutMs: START_TIMEOUT_MS,
    signal: opts.signal,
    onLog: (stream, chunk) => emit({ kind: 'log', stream, chunk }),
  });
  if (!start.ok && !/already running/i.test(start.stderrTail)) {
    emit({ kind: 'error', message: 'Failed to start the Podman machine.', stderrTail: start.stderrTail });
    return;
  }
  emit({ kind: 'done' });
}
