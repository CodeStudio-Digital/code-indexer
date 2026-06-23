/**
 * Link a published Design System (DS Studio) to a Builder project so the
 * builder agent can consume it: validate the DS session + published
 * version, make sure the local Verdaccio registry is reachable, map the
 * package scope in the project's `.npmrc`, `npm install` the exact pin and
 * persist the link inside `projects.builder_json.designSystem`.
 *
 * Shared by the New Project wizard scaffold (link at create time) and the
 * REST pair POST/DELETE /api/projects/:id/design-system/link (existing
 * projects). Deps are narrowed structurally so tests can pass fakes.
 */
import { ApiError } from '@mcp/api-bus';
import { installDsPackage, uninstallDsPackage } from '@mcp/services/host-scaffold/index.js';
import { tryGetVerdaccioService } from '@mcp/services/verdaccio/verdaccio-service.js';
import type { DesignSystemSession, DesignSystemVersion } from '@mcp/store/design-system-store.js';

export interface DsConsumerLink {
  sessionId: number;
  packageName: string;
  semver: string;
  linkedAt: string;
}

type LogFn = (stream: 'stdout' | 'stderr', chunk: string) => void;
type InstallRunCmd = Parameters<typeof installDsPackage>[0]['runCmd'];
type UninstallRunCmd = Parameters<typeof uninstallDsPackage>[0]['runCmd'];

/** Structural slices — ServerDeps satisfies them; tests pass fakes. */
export interface DsLinkStore {
  getSession(id: number): DesignSystemSession | null;
  getLatestPublishedVersion(sessionId: number): DesignSystemVersion | null;
  getVersionBySemver(sessionId: number, semver: string): DesignSystemVersion | null;
}
export interface DsLinkDeps {
  db: {
    getProject(id: number): { id: number; root_path: string; builder_json?: string | null } | null | undefined;
    updateProject(id: number, updates: { builder_json: string | null }): unknown;
  };
  designSystemStore: DsLinkStore;
}
export interface VerdaccioLike {
  getEndpoint(opts?: { probe?: boolean }): Promise<{
    enabled: boolean;
    status: string;
    alive?: boolean;
    loopbackUrl: string;
    lastError: string | null;
  }>;
  enable(): Promise<{ status: string; loopbackUrl: string; lastError: string | null }>;
}

export function resolveDsForLink(
  store: DsLinkStore,
  input: { dsSessionId: number; semver?: string; targetStack: string },
): { session: DesignSystemSession; version: DesignSystemVersion } {
  const session = store.getSession(input.dsSessionId);
  if (!session) throw new ApiError('not_found', 404, 'design system session not found');
  if (session.stack !== input.targetStack) {
    throw new ApiError(
      'stack_mismatch',
      400,
      `design system stack is '${session.stack}' but the project is '${input.targetStack}'`,
      { dsStack: session.stack, targetStack: input.targetStack },
    );
  }
  const version = input.semver
    ? store.getVersionBySemver(session.id, input.semver)
    : store.getLatestPublishedVersion(session.id);
  if (!version || version.status !== 'published') {
    throw new ApiError(
      'no_published_version',
      409,
      input.semver
        ? `version ${input.semver} of ${session.package_name} is not published`
        : `${session.package_name} has no published version yet — publish it from the DS Studio first`,
    );
  }
  return { session, version };
}

/** Returns the loopback registry URL once Verdaccio answers, else throws. */
export async function ensureVerdaccioRunning(verdaccio?: VerdaccioLike | null): Promise<string> {
  const svc = verdaccio ?? tryGetVerdaccioService();
  if (!svc) throw new ApiError('verdaccio_unwired', 503, 'Verdaccio service is not wired');
  let state: Awaited<ReturnType<VerdaccioLike['getEndpoint']>> | Awaited<ReturnType<VerdaccioLike['enable']>> =
    await svc.getEndpoint({ probe: true });
  if (state.status === 'running' && (state as { alive?: boolean }).alive !== false) {
    return state.loopbackUrl;
  }
  // Operator left it enabled but the container died → one restart attempt.
  if ((state as { enabled: boolean }).enabled) {
    state = await svc.enable();
    if (state.status === 'running') return state.loopbackUrl;
  }
  throw new ApiError(
    'verdaccio_unavailable',
    409,
    `Local npm registry (Verdaccio) is not running${state.lastError ? `: ${state.lastError}` : ''}. Enable it in Admin → Verdaccio and retry.`,
  );
}

export interface LinkDsToDirInput {
  targetDir: string;
  dsSessionId: number;
  /** Stack of the consuming project (builder_json.stack). */
  targetStack: string;
  semver?: string;
  signal?: AbortSignal;
  onLog?: LogFn;
  /** Test seams. */
  verdaccio?: VerdaccioLike | null;
  runCmd?: InstallRunCmd;
}

export async function linkDsToDir(deps: DsLinkDeps, input: LinkDsToDirInput): Promise<DsConsumerLink> {
  const { session, version } = resolveDsForLink(deps.designSystemStore, input);
  const registryUrl = await ensureVerdaccioRunning(input.verdaccio);
  const result = await installDsPackage({
    dir: input.targetDir,
    packageName: session.package_name,
    semver: version.semver,
    registryUrl,
    signal: input.signal,
    onLog: input.onLog,
    runCmd: input.runCmd,
  });
  if (!result.ok) {
    throw new ApiError(
      'ds_install_failed',
      500,
      `npm install ${session.package_name}@${version.semver} failed (exit ${result.exitCode}): ${result.stderrTail.slice(-400)}`,
    );
  }
  return {
    sessionId: session.id,
    packageName: session.package_name,
    semver: version.semver,
    linkedAt: new Date().toISOString(),
  };
}

function parseBuilderJson(project: { builder_json?: string | null }): Record<string, unknown> {
  if (!project.builder_json) throw new ApiError('not_builder', 400, 'project is not a Builder project');
  try {
    return JSON.parse(project.builder_json) as Record<string, unknown>;
  } catch {
    throw new ApiError('bad_builder_json', 400, 'builder_json is not valid JSON');
  }
}

export async function linkDesignSystem(
  deps: DsLinkDeps,
  input: { projectId: number; dsSessionId: number; semver?: string },
  signal?: AbortSignal,
  seams?: { verdaccio?: VerdaccioLike | null; runCmd?: LinkDsToDirInput['runCmd'] },
): Promise<{ ok: true; link: DsConsumerLink }> {
  const project = deps.db.getProject(input.projectId);
  if (!project) throw new ApiError('not_found', 404, 'project not found');
  const cfg = parseBuilderJson(project);
  if (cfg.kind === 'ds') {
    throw new ApiError('ds_workspace', 400, 'a Design System workspace cannot consume another design system');
  }
  const targetStack = typeof cfg.stack === 'string' ? cfg.stack : 'react-ts';
  const link = await linkDsToDir(deps, {
    targetDir: project.root_path,
    dsSessionId: input.dsSessionId,
    semver: input.semver,
    targetStack,
    signal,
    verdaccio: seams?.verdaccio,
    runCmd: seams?.runCmd,
  });
  deps.db.updateProject(project.id, { builder_json: JSON.stringify({ ...cfg, designSystem: link }) });
  return { ok: true, link };
}

export async function unlinkDesignSystem(
  deps: DsLinkDeps,
  input: { projectId: number },
  signal?: AbortSignal,
  seams?: { runCmd?: UninstallRunCmd },
): Promise<{ ok: true }> {
  const project = deps.db.getProject(input.projectId);
  if (!project) throw new ApiError('not_found', 404, 'project not found');
  const cfg = parseBuilderJson(project);
  const ds = cfg.designSystem as { packageName?: unknown } | undefined;
  const packageName = ds && typeof ds === 'object' && typeof ds.packageName === 'string' ? ds.packageName : null;
  if (!packageName) throw new ApiError('not_linked', 400, 'project has no linked design system');
  // Best-effort: a failed uninstall must not strand the link in builder_json.
  await uninstallDsPackage({ dir: project.root_path, packageName, signal, runCmd: seams?.runCmd });
  delete cfg.designSystem;
  deps.db.updateProject(project.id, { builder_json: JSON.stringify(cfg) });
  return { ok: true };
}
