/**
 * Launch chain do App Studio — o "Publicar" do leigo, server-side e
 * streamado (SSE, mesmo contrato do scaffold): auth → banco remoto →
 * migrations → build → deploy → health → persist. Iniciada pelo USUÁRIO
 * no painel (criar recurso remoto na conta CF dele nunca é ação do
 * agente); re-execução é idempotente (provisionRemote reusa o id,
 * migrations remotas são incrementais).
 */
import { setTimeout as delay } from 'node:timers/promises';
import { parseAppSpec } from '@mcp/app-studio/spec/types.js';
import { parseAppWorkflowState } from '@mcp/app-studio/workflow/state.js';
import { writeDeployStatus, type AppDeployStatusFile } from '@mcp/app-studio/status-files.js';
import { getDatabaseProvisioner } from '@mcp/services/app-studio/index.js';
import { runHostCommand } from '@mcp/services/host-scaffold/run-host-command.js';
import type { HandlerDeps } from '../types.js';
import { runWranglerWhoami } from './login-stream.js';

const BUILD_TIMEOUT_MS = 300_000;
const DEPLOY_TIMEOUT_MS = 300_000;
const HEALTH_ATTEMPTS = 10;
const HEALTH_INTERVAL_MS = 3_000;
const WORKERS_URL_RE = /https:\/\/[\w-]+(\.[\w-]+)*\.workers\.dev/;

export type AppLaunchEvent =
  | { event: 'start'; data: { app_slug: string } }
  | { event: 'phase'; data: { phase: string; label: string } }
  | { event: 'log'; data: { stream: 'stdout' | 'stderr'; chunk: string } }
  | { event: 'auth-required'; data: { message: string } }
  | { event: 'done'; data: { deploy: AppDeployStatusFile } }
  | { event: 'error'; data: { message: string } };

type Emit = (ev: AppLaunchEvent) => void;

/** Uma launch por sessão por vez (o botão da UI também trava, mas o servidor manda). */
const inflight = new Set<number>();

export async function runAppLaunchStream(
  deps: HandlerDeps,
  sessionId: number,
  emit: Emit,
  signal?: AbortSignal,
): Promise<void> {
  const session = deps.appStudioStore.getSession(sessionId);
  if (!session) {
    emit({ event: 'error', data: { message: `App Studio session ${sessionId} not found.` } });
    return;
  }
  const workflow = parseAppWorkflowState(session.pipeline_json);
  if (!workflow?.release_unlocked) {
    emit({ event: 'error', data: { message: 'Release approval is required before publishing.' } });
    return;
  }
  const project = deps.db.getProject(session.project_id);
  if (!project?.root_path) {
    emit({ event: 'error', data: { message: 'Workspace project missing.' } });
    return;
  }
  if (inflight.has(sessionId)) {
    emit({ event: 'error', data: { message: 'A publish is already running for this app.' } });
    return;
  }
  inflight.add(sessionId);

  const workspaceDir = project.root_path;
  const spec = parseAppSpec(session.spec_json);
  const onLog = (stream: 'stdout' | 'stderr', chunk: string) => emit({ event: 'log', data: { stream, chunk } });
  const phase = (id: string, label: string) => emit({ event: 'phase', data: { phase: id, label } });

  try {
    emit({ event: 'start', data: { app_slug: session.app_slug } });

    phase('auth', 'Checking Cloudflare account');
    const who = await runWranglerWhoami(workspaceDir);
    if (!who.logged_in) {
      emit({ event: 'auth-required', data: { message: 'Not connected to Cloudflare — run the login flow first.' } });
      return;
    }

    let databaseId: string | null = null;
    if (spec?.database.required) {
      const provisioner = getDatabaseProvisioner(session.db_engine);
      const pctx = { workspaceDir, appSlug: session.app_slug, bindingName: 'DB' as const, onLog, signal };
      phase('db', 'Creating the cloud database');
      const remote = await provisioner.provisionRemote(pctx);
      databaseId = remote.databaseId;

      phase('migrate', 'Preparing the cloud database');
      const migrated = await provisioner.applyRemoteMigrations(pctx);
      if (!migrated.ok) throw new Error(migrated.error ?? 'Remote migrations failed.');

      // Semeia o remoto SÓ na 1ª criação — com o mesmo seeds/seed.sql que
      // o usuário viu no preview. Reuso (re-deploy) não re-semeia (evita
      // duplicar linhas / apagar dados reais).
      if (remote.created) {
        const seeded = await provisioner.applyRemoteSeed(pctx);
        if (!seeded.ok) throw new Error(seeded.error ?? 'Remote seed failed.');
      }
    }

    phase('build', 'Packing the app');
    const build = await runHostCommand({
      program: 'npm',
      args: ['run', 'build'],
      cwd: workspaceDir,
      timeoutMs: BUILD_TIMEOUT_MS,
      signal,
      onLog,
    });
    if (!build.ok) throw new Error(`Build failed (exit ${build.exitCode}): ${build.stderrTail.slice(-500)}`);

    phase('deploy', 'Sending the app to the internet');
    let deployStdout = '';
    const deploy = await runHostCommand({
      program: 'npx',
      args: ['wrangler', 'deploy'],
      cwd: workspaceDir,
      timeoutMs: DEPLOY_TIMEOUT_MS,
      signal,
      onLog: (stream, chunk) => {
        if (stream === 'stdout') deployStdout += chunk;
        onLog(stream, chunk);
      },
    });
    if (!deploy.ok) throw new Error(`Deploy failed (exit ${deploy.exitCode}): ${deploy.stderrTail.slice(-500)}`);
    const url = deployStdout.match(WORKERS_URL_RE)?.[0] ?? null;
    if (!url) throw new Error('Deploy finished but no workers.dev URL was found in the output.');

    phase('health', 'Turning everything on');
    let healthy = false;
    for (let i = 0; i < HEALTH_ATTEMPTS && !healthy; i++) {
      try {
        const res = await fetch(`${url}/api/health`, { signal });
        healthy = res.ok;
      } catch {
        /* ainda propagando */
      }
      if (!healthy) await delay(HEALTH_INTERVAL_MS, undefined, { signal });
    }

    phase('persist', 'Saving the result');
    const deployStatus: AppDeployStatusFile = {
      url,
      health_ok: healthy,
      database_id: databaseId,
      account: who.email ?? who.accounts[0]?.name ?? null,
      deployed_at: new Date().toISOString(),
    };
    deps.appStudioStore.setDeployJson(sessionId, JSON.stringify(deployStatus));
    writeDeployStatus(workspaceDir, deployStatus);

    deps.appStudioStore.appendWorkflowEvent(
      sessionId,
      'publish.completed',
      'deploy',
      url,
      JSON.stringify({ url, health_ok: healthy, deployed_at: deployStatus.deployed_at }),
    );

    if (!healthy) {
      throw new Error(`Deployed to ${url} but the health check never turned green — open the app to inspect.`);
    }
    emit({ event: 'done', data: { deploy: deployStatus } });
  } catch (err) {
    emit({ event: 'error', data: { message: err instanceof Error ? err.message : String(err) } });
  } finally {
    inflight.delete(sessionId);
  }
}
