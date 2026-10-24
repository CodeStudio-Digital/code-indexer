/**
 * Host scaffold → register, as an emit-driven flow shared by both
 * transports:
 *   - api-bus `projects.scaffold` wraps it via `streamFromCallbacks`
 *     (Electron IPC).
 *   - the Hono SSE route calls it directly with `c.req.raw.signal` so a
 *     client disconnect aborts the child npm/git process.
 *
 * Registration happens ONLY on a successful scaffold, so a failed run
 * never leaves a dangling project row. The half-written directory is left
 * on disk (deleting on the host is destructive) and its path is reported.
 */
import type { ScaffoldProjectInput, ScaffoldStreamEvent } from '@mcp/api-bus';
import {
  runHostScaffold,
  validateScaffoldInput,
  runHostCommand,
  injectBuilderStampHost,
  findFreeBuilderPort,
  BUILDER_DEPS,
  BUILDER_DEV_DEPS,
  INSTALL_TIMEOUT_MS,
  NON_INTERACTIVE_ENV,
} from '@mcp/services/host-scaffold/index.js';
import { CreateProjectService, ProjectError } from '@mcp/services/services/projects/index.js';
import type { HandlerDeps } from '../types.js';

type Emit = (event: ScaffoldStreamEvent) => void;

/** Strip embedded credentials from an http(s) remote (scp-style git@ passes through).
 *  Mirrors the renderer's sanitizeGitRemote so a cloned remote is never stored with
 *  a token. */
function sanitizeRemote(url: string): string | null {
  const u = url.trim();
  if (!u) return null;
  return u.replace(/^(https?:\/\/)[^/@]*@/i, '$1');
}

export async function runScaffoldStream(
  deps: HandlerDeps,
  input: ScaffoldProjectInput,
  emit: Emit,
  signal?: AbortSignal,
): Promise<void> {
  let validated;
  try {
    validated = validateScaffoldInput(input);
  } catch (err) {
    emit({ event: 'error', data: { message: err instanceof Error ? err.message : String(err) } });
    return;
  }

  const outcome = await runHostScaffold(
    {
      ...validated,
      isNameTaken: (name) => !!deps.db.getProjectByName(name),
      signal,
    },
    {
      onStart: (data) => emit({ event: 'start', data }),
      onPhase: (data) => emit({ event: 'phase', data }),
      onLog: (stream, chunk) => emit({ event: 'log', data: { stream, chunk } }),
    },
  );

  if (!outcome.ok) {
    emit({ event: 'error', data: outcome.error });
    return;
  }

  // Builder mode: after the plain react-vite scaffold, install the
  // Tailwind/shadcn deps and bake in the element-selection source-stamp.
  // builderJson is persisted onto the project below so the project view
  // can render the live-preview pane + default the agent to `builder`.
  let builderJson: string | null = null;
  if (validated.builder) {
    try {
      const port = await findFreeBuilderPort();
      const targetDir = outcome.target.targetPath;
      emit({ event: 'phase', data: { phase: 'install-deps', label: 'Installing Tailwind + shadcn…' } });
      const install = await runHostCommand({
        program: 'npm',
        args: ['install', '--no-audit', '--no-fund', '--loglevel=error', ...BUILDER_DEPS, '-D', ...BUILDER_DEV_DEPS],
        cwd: targetDir,
        env: NON_INTERACTIVE_ENV,
        timeoutMs: INSTALL_TIMEOUT_MS,
        signal,
        onLog: (stream, chunk) => emit({ event: 'log', data: { stream, chunk } }),
      });
      if (!install.ok) {
        emit({ event: 'error', data: { message: `Builder dep install failed (exit ${install.exitCode})`, stderrTail: install.stderrTail } });
        return;
      }
      emit({ event: 'phase', data: { phase: 'configure', label: 'Instrumenting for element selection…' } });
      injectBuilderStampHost(targetDir, 'react-ts', port);
      builderJson = JSON.stringify({ stack: 'react-ts', port });
    } catch (err) {
      emit({ event: 'error', data: { message: `Builder instrumentation failed: ${err instanceof Error ? err.message : String(err)}` } });
      return;
    }
  }

  emit({ event: 'phase', data: { phase: 'register', label: 'Registering project' } });
  try {
    const project = new CreateProjectService(deps.db).execute({
      name: outcome.target.name,
      root_path: outcome.target.targetPath,
      description: validated.description,
    });
    if (builderJson) {
      deps.db.updateProject(project.id, { builder_json: builderJson });
    }
    // P6-C: a clone's repoUrl IS its origin remote — persist it (creds stripped) so
    // the project can be published to / restored from the cloud library.
    let gitRemoteSet = false;
    if (validated.template === 'git-clone' && validated.repoUrl) {
      const remote = sanitizeRemote(validated.repoUrl);
      if (remote) {
        deps.db.updateProject(project.id, { git_remote: remote });
        gitRemoteSet = true;
      }
    }
    const finalProject = builderJson || gitRemoteSet ? (deps.db.getProject(project.id) ?? project) : project;
    // Fresh scaffold is small — the structural index lands in <1s, so the
    // project opens already usable for symbols/grep. Fire-and-forget.
    deps.projectIndexService.ensureFresh(finalProject.id, 'scaffold');
    emit({ event: 'done', data: { project: finalProject } });
  } catch (err) {
    const message = err instanceof ProjectError || err instanceof Error ? err.message : String(err);
    emit({ event: 'error', data: { message: `Scaffold succeeded but registration failed: ${message}` } });
  }
}
