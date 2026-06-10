/**
 * Re-instrument an existing Builder project for element selection.
 *
 * Projects scaffolded before the stamp moved out of `react({ babel })` carry a
 * `vite.config.ts` whose Babel stamp never runs under `@vitejs/plugin-react` v6
 * (it transforms JSX with oxc and ignores the `babel` option), so no element
 * gets `data-mcp-loc` and the picker is a silent no-op. This rewrites the stamp
 * files + `vite.config.ts` (NOT the user's Tailwind/CSS) and ensures
 * `@babel/core` is installed. The caller restarts the dev server afterwards so
 * Vite reloads the regenerated config.
 */
import { ApiError } from '@mcp/api-bus';
import {
  repairBuilderStampHost,
  runHostCommand,
  INSTALL_TIMEOUT_MS,
  NON_INTERACTIVE_ENV,
} from '@mcp/services/host-scaffold/index.js';
import type { HandlerDeps } from '../types.js';

export interface ReinstrumentResult {
  ok: true;
  /** Pinned dev-server port — the UI restarts that server to apply the change. */
  port: number;
}

export async function reinstrumentBuilder(
  deps: HandlerDeps,
  { id }: { id: number },
  signal?: AbortSignal,
): Promise<ReinstrumentResult> {
  const project = deps.db.getProject(id);
  if (!project) throw new ApiError('not_found', 404, 'project not found');
  if (!project.builder_json) {
    throw new ApiError('not_builder', 400, 'project is not a Builder project');
  }

  let cfg: { stack?: string; port?: number };
  try {
    cfg = JSON.parse(project.builder_json) as { stack?: string; port?: number };
  } catch {
    throw new ApiError('bad_builder_json', 400, 'builder_json is not valid JSON');
  }
  if (!cfg.stack || !cfg.port) {
    throw new ApiError('bad_builder_json', 400, 'builder_json is missing stack/port');
  }

  // Ensure @babel/core (powers the dev-only stamp plugin). Idempotent: npm
  // install is a no-op when it's already present.
  const install = await runHostCommand({
    program: 'npm',
    args: ['install', '-D', '--no-audit', '--no-fund', '--loglevel=error', '@babel/core'],
    cwd: project.root_path,
    env: NON_INTERACTIVE_ENV,
    timeoutMs: INSTALL_TIMEOUT_MS,
    signal,
  });
  if (!install.ok) {
    throw new ApiError('install_failed', 500, `@babel/core install failed (exit ${install.exitCode})`);
  }

  try {
    repairBuilderStampHost(project.root_path, cfg.stack, cfg.port);
  } catch (err) {
    throw new ApiError('reinstrument_failed', 500, err instanceof Error ? err.message : String(err));
  }

  return { ok: true, port: cfg.port };
}
