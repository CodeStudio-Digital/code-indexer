/**
 * LocalProcessManager — sibling of `SandboxManager` for projects that
 * run as a host OS process (not inside a container).
 *
 * Why not a driver: `ISandboxDriver` is container-shaped (writeFile,
 * readFile, isolation, image pulling, scaffolder hooks). None of that
 * applies when the project already exists on the user's disk. A driver
 * with 8 stubbed methods would violate LSP and mislead readers.
 *
 * What the manager owns:
 *   - In-memory map `sessionId → LocalProcess`.
 *   - Shared `PortAllocator` singleton (so ports don't collide with
 *     containers).
 *   - Child-process lifecycle (spawn, SIGTERM + SIGKILL, exit tracking).
 *   - HTTP readiness probe.
 *   - `SandboxEvent` emission in the same envelope as the container
 *     path, so `MetaBusPublisher` / `DevServerLogOverlay` / the
 *     `ServicesSidebar` all work without modification.
 *   - Persistence through `CompanyLocalProjectStore` (wired via setter).
 *
 * What it does NOT own:
 *   - Path validation (the HTTP route does it — see `local-project.ts`).
 *   - Command synthesis (see `command-synth/`).
 *   - Preview proxying (see `preview.ts`).
 */

import { EventEmitter } from 'node:events';
import { spawn, type ChildProcessByStdio } from 'node:child_process';
import type { Readable } from 'node:stream';
import type { SandboxEvent, SandboxObserver } from '../types.js';
import {
  defaultPortAllocator,
  type PortAllocator,
} from '../port-allocator.js';
import { httpReadinessProbe } from './readiness-probe.js';
import type { LocalProjectManifestKind } from '@mcp/store/company-local-project-store.js';
import type {
  CompanyLocalProjectStore,
  LocalProjectSynthSource,
  LocalProjectStatus,
} from '@mcp/store/company-local-project-store.js';

// ─────────────────────────────────────────────────────────── store wiring

let projectStore: CompanyLocalProjectStore | null = null;

export function setCompanyLocalProjectStore(
  store: CompanyLocalProjectStore | null,
): void {
  projectStore = store;
}

function store(): CompanyLocalProjectStore | null {
  return projectStore;
}

// ──────────────────────────────────────────────────────── domain types

export type LocalProcessStatus = LocalProjectStatus;

export interface LocalProcess {
  sessionId: string;
  cwd: string;
  manifestKind: LocalProjectManifestKind;
  program: string;
  args: string[];
  env: Record<string, string>;
  hostPort: number;
  pid: number | null;
  status: LocalProcessStatus;
  /** Absolute URL the dashboard can iframe. Proxied, same as sandbox. */
  previewUrl: string;
  error?: string;
  rationale: string;
  synthSource: LocalProjectSynthSource;
  createdAt: number;
  lastAccessAt: number;
}

export interface StartLocalProcessInput {
  sessionId: string;
  cwd: string;
  manifestKind: LocalProjectManifestKind;
  program: string;
  args: readonly string[];
  env: Record<string, string>;
  rationale: string;
  synthSource: LocalProjectSynthSource;
  /** `/` unless the synthesizer requested a different probe target. */
  readyProbePath?: string;
  /** Overall readiness deadline. Defaults to 30s. */
  readinessTimeoutMs?: number;
  /** Cancellation from the HTTP client (AbortController on request). */
  signal?: AbortSignal;
}

export interface StartLocalProcessResult {
  sessionId: string;
  hostPort: number;
  pid: number;
  previewUrl: string;
  program: string;
  args: string[];
}

// ─────────────────────────────────────────────────────────── manager

export class LocalProcessManager {
  private readonly processes = new Map<string, LocalProcess>();
  private readonly children = new Map<string, ChildProcessByStdio<null, Readable, Readable>>();
  private readonly emitter = new EventEmitter();
  private readonly allocator: PortAllocator;

  constructor(opts: { allocator?: PortAllocator } = {}) {
    this.allocator = opts.allocator ?? defaultPortAllocator();
  }

  // ─────────────────────────────────────────────── observers

  subscribe(observer: SandboxObserver): () => void {
    const wrapped = (event: SandboxEvent) => observer(event);
    this.emitter.on('event', wrapped);
    return () => this.emitter.off('event', wrapped);
  }

  private emit(event: SandboxEvent): void {
    this.emitter.emit('event', event);
  }

  // ─────────────────────────────────────────────── queries

  get(sessionId: string): LocalProcess | undefined {
    return this.processes.get(sessionId);
  }

  listAll(): LocalProcess[] {
    return [...this.processes.values()];
  }

  // ─────────────────────────────────────────────── lifecycle

  async start(input: StartLocalProcessInput): Promise<StartLocalProcessResult> {
    if (this.processes.has(input.sessionId)) {
      throw new Error(
        `Local project already running for session ${input.sessionId}; stop it first.`,
      );
    }

    const port = await this.allocator.acquire();
    // Phase C: direct loopback URL — the /preview/:id/ proxy was removed.
    const previewUrl = `http://127.0.0.1:${port}/`;
    const args = [...input.args];
    const env = { ...input.env, PORT: String(port), HOST: '127.0.0.1' };
    const now = Date.now();

    const process: LocalProcess = {
      sessionId: input.sessionId,
      cwd: input.cwd,
      manifestKind: input.manifestKind,
      program: input.program,
      args,
      env,
      hostPort: port,
      pid: null,
      status: 'provisioning',
      previewUrl,
      rationale: input.rationale,
      synthSource: input.synthSource,
      createdAt: now,
      lastAccessAt: now,
    };
    this.processes.set(input.sessionId, process);

    this.persist(input.sessionId, process);
    this.emit({ kind: 'provisioning', sandboxId: input.sessionId, stack: 'local-process' });
    this.emit({
      kind: 'step',
      sandboxId: input.sessionId,
      step: 'starting-dev-server',
      message: `Spawning ${input.program} ${args.join(' ')}`,
    });

    let child: ChildProcessByStdio<null, Readable, Readable>;
    try {
      child = spawn(input.program, args, {
        cwd: input.cwd,
        env: { ...getParentEnv(), ...env },
        // stdio tuple gives us typed stdout/stderr streams; stdin is ignored.
        stdio: ['ignore', 'pipe', 'pipe'],
        // Windows needs shell:false to keep argv semantics.
        shell: false,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.allocator.release(port);
      this.processes.delete(input.sessionId);
      this.persistStatus(input.sessionId, 'error', msg);
      this.emit({ kind: 'error', sandboxId: input.sessionId, message: msg });
      throw err;
    }

    this.children.set(input.sessionId, child);
    process.pid = child.pid ?? null;
    this.persist(input.sessionId, process);

    // Captures the earliest actionable failure so `start()` can throw
    // something the UI can surface — not the generic "Process exited
    // before becoming ready" which hides the root cause (ENOENT, port
    // permission, syntax error in dev script, etc.).
    let earlyFailure: { code: string; message: string } | null = null;
    // Tail of stderr so we can include a hint on non-zero exit even
    // when there was no explicit `error` event (common path for `npm
    // run dev` where npm swallows errors and exits with code 1).
    let stderrTail = '';

    child.stdout.setEncoding('utf-8');
    child.stderr.setEncoding('utf-8');
    child.stdout.on('data', (chunk: string) => {
      this.emit({
        kind: 'log',
        sandboxId: input.sessionId,
        stream: 'stdout',
        chunk,
      });
    });
    child.stderr.on('data', (chunk: string) => {
      stderrTail = (stderrTail + chunk).slice(-2_000);
      this.emit({
        kind: 'log',
        sandboxId: input.sessionId,
        stream: 'stderr',
        chunk,
      });
    });
    child.on('error', (err) => {
      const raw = err instanceof Error ? err.message : String(err);
      const enoentHint =
        raw.includes('ENOENT')
          ? ` — '${input.program}' was not found on PATH. ` +
            (input.program === 'yarn' || input.program === 'pnpm'
              ? `Install it, or uncheck "Use AI" to let the fallback use npm instead.`
              : `Install it or pick a program that's on your PATH.`)
          : '';
      const msg = `spawn failed: ${raw}${enoentHint}`;
      if (!earlyFailure) earlyFailure = { code: 'SPAWN_FAILED', message: msg };
      this.emit({ kind: 'error', sandboxId: input.sessionId, message: msg });
      this.handleExit(input.sessionId, 'spawn-error', msg);
    });
    child.on('exit', (code, signal) => {
      const reason =
        signal ? `exited on signal ${signal}` : `exited with code ${code ?? 'null'}`;
      const current = this.processes.get(input.sessionId);
      if (current && current.status !== 'destroying' && current.status !== 'destroyed') {
        const tailHint = stderrTail.trim()
          ? `\nLast stderr: ${stderrTail.trim().slice(-400)}`
          : '';
        const msg = `${reason}${tailHint}`;
        if (!earlyFailure) earlyFailure = { code: 'EARLY_EXIT', message: msg };
        this.emit({ kind: 'error', sandboxId: input.sessionId, message: msg });
      }
      this.handleExit(input.sessionId, signal ?? 'exit', reason);
    });

    // Run the readiness probe. If it fails, tear down the process but
    // bubble an error so the HTTP caller can surface it in the UI.
    const probe = await httpReadinessProbe({
      port,
      path: input.readyProbePath ?? '/',
      timeoutMs: input.readinessTimeoutMs ?? 30_000,
      signal: input.signal,
    });

    const live = this.processes.get(input.sessionId);
    if (!live) {
      // Child already died. Prefer the captured error (ENOENT / exit
      // code + stderr tail) over the generic fallback text.
      const fallback = earlyFailure as { code: string; message: string } | null;
      const msg = fallback?.message ?? 'Process exited before becoming ready.';
      const err = new Error(msg);
      (err as Error & { code?: string }).code = fallback?.code ?? 'EARLY_EXIT';
      throw err;
    }

    if (!probe.ok) {
      const reason =
        probe.reason === 'aborted'
          ? 'Readiness probe aborted.'
          : 'Project did not respond on the allocated port before timeout. ' +
            'The dev script may be using a hardcoded port — edit it to honor PORT, ' +
            'or use the container mode.';
      live.status = 'error';
      live.error = reason;
      this.persistStatus(input.sessionId, 'error', reason);
      this.emit({ kind: 'error', sandboxId: input.sessionId, message: reason });
      await this.stop(input.sessionId, 'readiness-failed');
      const err = new Error(reason);
      (err as Error & { code?: string }).code = 'READINESS_FAILED';
      throw err;
    }

    live.status = 'running';
    live.lastAccessAt = Date.now();
    this.persistStatus(input.sessionId, 'running', null);
    this.emit({ kind: 'ready', sandboxId: input.sessionId, previewUrl });

    return {
      sessionId: input.sessionId,
      hostPort: port,
      pid: live.pid ?? 0,
      previewUrl,
      program: live.program,
      args: live.args,
    };
  }

  async stop(sessionId: string, reason = 'user-stopped'): Promise<void> {
    const live = this.processes.get(sessionId);
    const child = this.children.get(sessionId);
    if (!live && !child) return;

    if (live && live.status !== 'destroyed') {
      live.status = 'destroying';
      this.persistStatus(sessionId, 'destroying', null);
      this.emit({ kind: 'destroying', sandboxId: sessionId, reason });
    }

    if (child && !child.killed) {
      // SIGTERM first, fall back to SIGKILL after 5s. On Windows, `SIGTERM`
      // is mapped to process.kill — which terminates unconditionally.
      try {
        child.kill('SIGTERM');
      } catch {
        /* already dead */
      }
      await new Promise<void>((resolve) => {
        let done = false;
        const finish = () => {
          if (done) return;
          done = true;
          resolve();
        };
        const timer = setTimeout(() => {
          try {
            child.kill('SIGKILL');
          } catch {
            /* ignore */
          }
          finish();
        }, 5_000);
        child.once('exit', () => {
          clearTimeout(timer);
          finish();
        });
      });
    }

    this.children.delete(sessionId);
    if (live) {
      this.allocator.release(live.hostPort);
      live.status = 'destroyed';
    }
    this.processes.delete(sessionId);
    this.persistStatus(sessionId, 'destroyed', null);
    this.emit({ kind: 'destroyed', sandboxId: sessionId });
  }

  /**
   * Stop every live local process (app shutdown). Reuses the per-session
   * SIGTERM→SIGKILL ladder in `stop()`. Without this, company dev servers
   * spawned here survive the app and keep holding their ports.
   */
  async killAll(reason = 'app-quit'): Promise<void> {
    const ids = new Set<string>([...this.processes.keys(), ...this.children.keys()]);
    await Promise.allSettled([...ids].map((id) => this.stop(id, reason)));
  }

  // ─────────────────────────────────────────────── internals

  private handleExit(sessionId: string, _signal: NodeJS.Signals | string, reason: string): void {
    const live = this.processes.get(sessionId);
    if (!live) return;
    if (live.status === 'destroying' || live.status === 'destroyed') return;
    live.status = 'error';
    live.error = reason;
    this.persistStatus(sessionId, 'error', reason);
    this.allocator.release(live.hostPort);
    this.children.delete(sessionId);
    this.processes.delete(sessionId);
  }

  private persist(sessionId: string, p: LocalProcess): void {
    const s = store();
    if (!s) return;
    const numericId = Number(sessionId);
    if (!Number.isFinite(numericId)) return;
    try {
      s.upsert({
        session_id: numericId,
        cwd: p.cwd,
        manifest_kind: p.manifestKind,
        program: p.program,
        args: p.args,
        env: p.env,
        host_port: p.hostPort,
        rationale: p.rationale,
        synth_source: p.synthSource,
        status: p.status,
        error: p.error ?? null,
        pid: p.pid,
        last_access_at_ms: p.lastAccessAt,
      });
    } catch {
      /* non-fatal — persistence is best-effort */
    }
  }

  private persistStatus(
    sessionId: string,
    status: LocalProcessStatus,
    error: string | null,
  ): void {
    const s = store();
    if (!s) return;
    const numericId = Number(sessionId);
    if (!Number.isFinite(numericId)) return;
    try {
      s.patch(numericId, { status, error, last_access_at_ms: Date.now() });
    } catch {
      /* non-fatal */
    }
  }
}

// ─────────────────────────────────────────────────────────── singleton

let singleton: LocalProcessManager | null = null;

export function getLocalProcessManager(): LocalProcessManager {
  if (!singleton) singleton = new LocalProcessManager();
  return singleton;
}

export function setLocalProcessManagerForTests(mgr: LocalProcessManager | null): void {
  singleton = mgr;
}

function getParentEnv(): NodeJS.ProcessEnv {
  // Isolate from child-process's implicit inheritance of our PATH when
  // nothing else applies. We return process.env so tools like npm find
  // their shell/PATH on both Windows and POSIX.
  return globalThis.process?.env ?? {};
}
