/**
 * Handlers for the `runner` namespace — the task player.
 *
 * Detects runnable commands (see ./detect.ts) and runs them as PTYs in
 * the shared manager, so a run survives renderer navigation and its
 * colored output streams through `terminal.output`. The registry here
 * only tracks metadata + status; the PTY lifecycle lives in PtyManager.
 *
 * No "pause" — OS suspend isn't portable. Controls are stop + restart.
 */

import { randomUUID } from 'node:crypto';
import { mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { ensureDataDir } from '@mcp/shared/utils/config.js';
import { ApiError, type RunnerApi, type RunnerManager, type RunnerStartInput, type RunnerTask, type RuntimeTarget, type TerminalShell, snippetRunFor } from '@mcp/api-bus';
import { parsePackageManagers } from '@mcp/shared/utils/package-managers.js';
import { parseWslPackageManagers } from '@mcp/shared/utils/wsl-package-managers.js';
import type { Project } from '@mcp/shared/types.js';
import type { HandlerDeps } from '../types.js';
import { defaultShell, sharedPtyManager } from '../terminal/pty-manager.js';
import { shellFamilyForExecutable } from '../terminal/shell-quote.js';
import { resolveShellById, targetForShell } from '../terminal/shells.js';
import { resolveProjectRuntimeEnv } from '../runtime/runtime-resolve.js';
import { detectRunnersAsync, type DetectOptions } from './detect.js';
import { probeManagerStatus, probeWslManagerStatus } from './manager-status.js';
import { searchPackages as searchPackageRegistry } from './package-search.js';
import { addDependency } from './dependency-ops.js';
import { resolveFileRunTargetAsync } from './file-run-target.js';

const VALID_NODE_MANAGERS: ReadonlySet<string> = new Set(['npm', 'yarn', 'pnpm', 'bun']);
const VALID_PY_MANAGERS: ReadonlySet<string> = new Set(['pip', 'poetry']);
const VALID_JAVA_MANAGERS: ReadonlySet<string> = new Set(['maven', 'gradle']);

/**
 * The temp-file path form a snippet interpreter expects. On Windows, Git Bash's
 * MSYS bash opens a POSIX path (`/c/Users/…`), NOT a Windows `C:/Users/…` one
 * (that fails with "No such file"); native interpreters (php/python/node) take
 * the forward-slash Windows path. On POSIX the absolute path is used as-is.
 * (WSL bash, which would need `/mnt/c/…`, is not handled — uncommon as a runner
 * shell on this IDE.)
 */
function snippetCmdPath(file: string, bin: string): string {
  if (process.platform !== 'win32') return file;
  const fwd = file.replace(/\\/g, '/');
  return bin === 'bash'
    ? fwd.replace(/^([A-Za-z]):\//, (_m, d: string) => `/${d.toLowerCase()}/`)
    : fwd;
}

/** Snippet temp files older than this are crash-orphans, safe to reap. */
const SNIPPET_STALE_MS = 60 * 60 * 1000; // 1h

/**
 * Reap STALE snippet temp files (crash-orphans) on startup. Age-aware on
 * purpose: a blunt recursive wipe would delete a SECOND app instance's
 * in-flight snippet (the dir is shared across processes); only files untouched
 * for an hour — long past any live run — are removed.
 */
function sweepStaleSnippets(dir: string): void {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return; // dir doesn't exist yet — nothing to reap
  }
  const cutoff = Date.now() - SNIPPET_STALE_MS;
  for (const name of entries) {
    const f = join(dir, name);
    try {
      if (statSync(f).mtimeMs < cutoff) rmSync(f, { force: true });
    } catch {
      /* vanished / locked by another instance — leave it */
    }
  }
}

export function createRunnerHandlers(deps: Pick<HandlerDeps, 'db' | 'resolveProjectWorktree'>): RunnerApi {
  const { db } = deps;
  const manager = sharedPtyManager;
  const tasks = new Map<string, RunnerTask>();
  const bus = new TaskBus();

  // Temp files for markdown snippet runs (`runner.runSnippet`). Each is deleted
  // when its run exits; this startup pass only reaps crash-orphans (age-aware,
  // so it never deletes a second app instance's in-flight snippet).
  const snippetsDir = join(ensureDataDir(), 'snippets');
  sweepStaleSnippets(snippetsDir);

  function snapshot(): RunnerTask[] {
    return [...tasks.values()].map((t) => ({ ...t }));
  }

  function emit(): void {
    bus.push(snapshot());
  }

  async function project(projectId: number, signal: AbortSignal) {
    const p = await db.getProjectAsync(projectId, signal);
    if (!p) throw new ApiError('not_found', 404, 'project not found');
    return p;
  }

  /** The runtime target a run/detect applies to: explicit, else the project's runner_shell env. */
  async function effectiveTarget(p: Project, explicit: RuntimeTarget | undefined): Promise<RuntimeTarget> {
    return explicit ?? targetForShell(await resolveShellById(p.runner_shell));
  }

  /**
   * Per-environment package-manager override for `detect`. Allowlist-validate
   * each key before it becomes part of a spawnable command (the JSON is opaque
   * in the DB; an unknown value falls back to lockfile auto-detect).
   */
  async function detectOptionsFor(p: Project, explicit?: RuntimeTarget): Promise<DetectOptions> {
    const configuredShell = await resolveShellById(p.runner_shell);
    const target = explicit ?? targetForShell(configuredShell);
    const pm =
      target.kind === 'wsl'
        ? parseWslPackageManagers(p.wsl_package_managers)[target.distro] ?? {}
        : parsePackageManagers(p.package_managers);
    const shellFile = target.kind === 'wsl'
      ? 'wsl.exe'
      : configuredShell && targetForShell(configuredShell).kind !== 'wsl'
        ? configuredShell.file
        : defaultShell();
    const shellFamily = shellFamilyForExecutable(shellFile, target.kind === 'wsl');
    return {
      nodeManager: VALID_NODE_MANAGERS.has(pm.node ?? '') ? (pm.node as RunnerManager) : undefined,
      pythonManager: VALID_PY_MANAGERS.has(pm.python ?? '') ? (pm.python as RunnerManager) : undefined,
      javaManager: VALID_JAVA_MANAGERS.has(pm.java ?? '') ? (pm.java as RunnerManager) : undefined,
      shellFamily,
    };
  }

  async function worktreeFor(p: Project, requested: RunnerStartInput['worktreePath'], signal: AbortSignal) {
    signal.throwIfAborted();
    if (requested == null) return null;
    try {
      return await deps.resolveProjectWorktree(p.root_path, requested, { signal });
    } catch (error) {
      signal.throwIfAborted();
      throw new ApiError('invalid_input', 400, error instanceof Error ? error.message : String(error));
    }
  }

  async function runnerCheckout(projectId: number, requested: RunnerStartInput['worktreePath'], signal: AbortSignal) {
    const selected = db.getProjectCatalogEntry(projectId);
    if (!selected) throw new ApiError('not_found', 404, 'project not found');
    const owner = await project(selected.worktree_parent_id ?? projectId, signal);
    if (!selected.worktree_parent_id) return { owner, checkout: await worktreeFor(owner, requested, signal) };
    if (requested != null) throw new ApiError('invalid_input', 400, 'Project already identifies a worktree');
    const checkout = await worktreeFor(owner, selected.root_path, signal);
    if (!checkout) throw new ApiError('invalid_input', 400, 'Linked worktree is unavailable');
    return { owner, checkout };
  }

  /** Resolve a checkout-relative cwd, confined to the checkout root (escape → root). */
  function resolveCwdInRoot(root: string, rel: string | undefined): string {
    if (!rel) return root;
    const abs = resolve(root, rel);
    const r = relative(root, abs);
    return r.startsWith('..') || isAbsolute(r) ? root : abs;
  }

  function launch(p: Project, input: RunnerStartInput, worktreePath: string | null, configuredShell: TerminalShell | null): RunnerTask {
    const cwd = resolveCwdInRoot(worktreePath ?? p.root_path, input.cwd);
    // Per-project runner shell — resolve the stored id to a spawnable
    // {file,args}; null falls back to the system default shell. The shell
    // decides the runtime target: a WSL distro gets its Linux managed runtimes
    // on the POSIX PATH, everything else (incl. Git Bash) the Windows ones.
    const configuredTarget = targetForShell(configuredShell);
    const runTarget = input.target ?? configuredTarget;
    const shellSel = input.target?.kind === 'wsl'
      ? { id: `wsl:${input.target.distro}`, label: `WSL: ${input.target.distro}`, file: 'wsl.exe', args: ['-d', input.target.distro] }
      : input.target?.kind === 'host' && configuredTarget.kind === 'wsl'
        ? null
        : configuredShell;
    const { pathPrepend, extraEnv, posixPathPrepend, posixExtraEnv } = resolveProjectRuntimeEnv(
      db,
      input.projectId,
      ensureDataDir(),
      { target: runTarget },
    );
    const { id: terminalId } = manager.spawn({
      command: input.command,
      cwd,
      cols: 80,
      rows: 24,
      pathPrepend,
      extraEnv,
      posixPathPrepend,
      posixExtraEnv,
      shell: shellSel?.file,
      shellArgs: shellSel?.args,
      // A finished task stays visible until the user dismisses it, so its
      // bounded PTY replay buffer must follow the same lifecycle.
      retainOnExit: true,
      meta: {
        label: `${p.name}: ${input.label}`,
        cwd,
        kind: 'runner',
      },
    });
    const task: RunnerTask = {
      taskId: randomUUID(),
      terminalId,
      projectId: input.projectId,
      projectName: p.name,
      label: input.label,
      command: input.command,
      manager: input.manager,
      cwd: input.cwd,
      worktreePath: worktreePath ?? undefined,
      target: input.target,
      status: 'running',
      exitCode: null,
      startedAt: Date.now(),
    };
    tasks.set(task.taskId, task);
    // Flip status when the PTY exits — unless we already marked it
    // 'stopped' via an explicit kill (don't clobber that).
    manager.onExit(terminalId, (code) => {
      const current = tasks.get(task.taskId);
      if (!current || current.status === 'stopped') return;
      current.status = 'exited';
      current.exitCode = code;
      emit();
    });
    emit();
    return { ...task };
  }

  return {
    async detect({ projectId, target, worktreePath }, { signal }) {
      // Per-project package-manager override (settings) wins over the lockfile
      // auto-detect, resolved for the run ENVIRONMENT (host or a WSL distro) so
      // the WSL list/commands honour the distro's chosen manager.
      const { owner: p, checkout } = await runnerCheckout(projectId, worktreePath, signal);
      signal.throwIfAborted();
      return detectRunnersAsync(checkout ?? p.root_path, await detectOptionsFor(p, target));
    },

    async managerStatus({ projectId, manager, target }, { signal }) {
      // Probe `<manager> --version` on the project's effective PATH for the
      // environment: host PATH, or inside the WSL distro with its managed
      // runtimes prepended.
      const p = await project(projectId, signal);
      const rt = await effectiveTarget(p, target);
      if (rt.kind === 'wsl') {
        const env = resolveProjectRuntimeEnv(db, projectId, ensureDataDir(), { target: rt });
        return probeWslManagerStatus(manager, rt.distro, env, p.root_path);
      }
      const env = resolveProjectRuntimeEnv(db, projectId, ensureDataDir());
      return probeManagerStatus(manager, env, p.root_path);
    },

    async searchPackages({ projectId, manager, query, limit }) {
      if (!db.getProjectCatalogEntry(projectId)) throw new ApiError('not_found', 404, 'project not found');
      return searchPackageRegistry(manager, query, limit);
    },

    async addDependency({ projectId, manager, packageId, version, projectFile, target }, { signal }) {
      const p = await project(projectId, signal);
      const rt = await effectiveTarget(p, target);
      const env = resolveProjectRuntimeEnv(db, projectId, ensureDataDir(), { target: rt });
      return addDependency({ root: p.root_path, manager, packageId, version, projectFile, target: rt, env });
    },

    async fileRunTarget({ projectId, file, content, script, target }, { signal }) {
      const p = await project(projectId, signal);
      const options = await detectOptionsFor(p, target);
      let detectionRoot = p.root_path;
      const base = basename(file).toLowerCase();
      if ((script && ['package.json', 'composer.json'].includes(base))
        || ['pom.xml', 'build.gradle', 'build.gradle.kts'].includes(base)) {
        const absolute = resolve(p.root_path, file);
        const rel = relative(p.root_path, absolute);
        if (rel.startsWith('..') || isAbsolute(rel)) throw new ApiError('invalid_input', 400, 'file escapes the project root');
        detectionRoot = dirname(absolute);
      }
      const groups = (await detectRunnersAsync(detectionRoot, options)).groups;
      return resolveFileRunTargetAsync(p.root_path, file, content, groups, options.shellFamily, script);
    },

    async start(input, { signal }) {
      const { owner, checkout } = await runnerCheckout(input.projectId, input.worktreePath, signal);
      const shell = await resolveShellById(owner.runner_shell);
      signal.throwIfAborted();
      return launch(owner, { ...input, projectId: owner.id }, checkout, shell);
    },

    async runSnippet({ projectId, language, code, label }, { signal }) {
      // Validate the project + language BEFORE writing a temp file (so an
      // unknown language / missing project never orphans one).
      const { owner, checkout } = await runnerCheckout(projectId, null, signal);
      const shell = await resolveShellById(owner.runner_shell);
      signal.throwIfAborted();
      const run = snippetRunFor(language);
      if (!run) throw new ApiError('invalid_input', 400, `unsupported snippet language: ${language}`);
      const file = join(snippetsDir, `${randomUUID()}.${run.ext}`);
      try {
        mkdirSync(snippetsDir, { recursive: true });
        writeFileSync(file, code, 'utf8');
      } catch (e) {
        throw new ApiError('internal', 500, `failed to write snippet: ${e instanceof Error ? e.message : String(e)}`);
      }
      // Pass the temp path UNQUOTED (the winpty + nested-shell layers mangle
      // quotes; the snippets dir under the user home is space-free for all
      // practical users) and in the form THIS interpreter expects (see
      // snippetCmdPath: Git Bash needs a POSIX /c/… path, native binaries take
      // the C:/… form).
      const cmdPath = snippetCmdPath(file, run.bin);
      const task = launch(owner, { projectId: owner.id, command: `${run.bin} ${cmdPath}`, label, manager: run.manager }, checkout, shell);
      // Delete the temp file once the run exits — by then the interpreter has
      // read it. (A second onExit hook; the PtyManager keeps a hook Set, so this
      // doesn't clobber launch()'s status-flip hook.)
      manager.onExit(task.terminalId, () => { try { rmSync(file, { force: true }); } catch { /* already gone */ } });
      return task;
    },

    async stop({ taskId }) {
      const task = tasks.get(taskId);
      if (!task) throw new ApiError('not_found', 404, 'task not found');
      task.status = 'stopped';
      try {
        manager.kill(task.terminalId);
      } catch {
        /* PTY may have already exited — status still reflects intent */
      }
      emit();
    },

    async dismiss({ taskId }) {
      const task = tasks.get(taskId);
      if (!task) return;
      // Releases the retained replay buffer and also terminates the process
      // tree if the task is somehow still running.
      manager.release(task.terminalId);
      tasks.delete(taskId);
      emit();
    },

    async restart({ taskId }, { signal }) {
      const task = tasks.get(taskId);
      if (!task) throw new ApiError('not_found', 404, 'task not found');
      const p = await project(task.projectId, signal);
      const checkout = await worktreeFor(p, task.worktreePath, signal);
      const shell = await resolveShellById(p.runner_shell);
      signal.throwIfAborted();
      if (tasks.get(taskId) !== task) throw new ApiError('not_found', 404, 'task not found');
      try {
        manager.release(task.terminalId);
      } catch {
        /* already gone */
      }
      tasks.delete(taskId);
      try {
        return launch(p, task, checkout, shell);
      } catch (error) {
        emit();
        throw error;
      }
    },

    async list() {
      return snapshot();
    },

    events() {
      return bus.iterable(snapshot());
    },
  };
}

/**
 * Broadcaster for task-list snapshots. Each `events()` consumer gets its
 * own queue + waiter so a slow reader doesn't block the others. Mirrors
 * the backpressure shape of the terminal output iterable.
 */
class TaskBus {
  private readonly subscribers = new Set<(snap: RunnerTask[]) => void>();

  push(snap: RunnerTask[]): void {
    for (const s of this.subscribers) s(snap);
  }

  iterable(initial: RunnerTask[]): AsyncIterable<RunnerTask[]> {
    const subscribers = this.subscribers;
    return {
      [Symbol.asyncIterator](): AsyncIterator<RunnerTask[]> {
        const queue: RunnerTask[][] = [initial];
        const waiters: Array<(r: IteratorResult<RunnerTask[]>) => void> = [];
        const onSnap = (snap: RunnerTask[]) => {
          const w = waiters.shift();
          if (w) w({ value: snap, done: false });
          else queue.push(snap);
        };
        subscribers.add(onSnap);
        return {
          async next(): Promise<IteratorResult<RunnerTask[]>> {
            if (queue.length > 0) return { value: queue.shift()!, done: false };
            return new Promise((resolve) => waiters.push(resolve));
          },
          async return(): Promise<IteratorResult<RunnerTask[]>> {
            subscribers.delete(onSnap);
            return { value: undefined as never, done: true };
          },
        };
      },
    };
  }
}
