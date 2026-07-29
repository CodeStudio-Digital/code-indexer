/**
 * Launch chain do App Studio — o "Publicar" do leigo, server-side e
 * streamado (SSE, mesmo contrato do scaffold): auth → banco remoto →
 * migrations → build → deploy → health → persist. Iniciada pelo USUÁRIO
 * no painel (criar recurso remoto na conta CF dele nunca é ação do
 * agente); re-execução é idempotente (provisionRemote reusa o id,
 * migrations remotas são incrementais).
 */
import { setTimeout as delay } from 'node:timers/promises';
import { auditAppPlan } from '@mcp/app-studio/plan/fitness.js';
import { appWorkspaceFingerprint } from '@mcp/app-studio/plan/evidence.js';
import { parseAppPlan } from '@mcp/app-studio/plan/types.js';
import { writeDeployStatus, type AppDeployStatusFile } from '@mcp/app-studio/status-files.js';
import { getDatabaseProvisioner } from '@mcp/services/app-studio/index.js';
import { runHostCommand } from '@mcp/services/host-scaffold/run-host-command.js';
import type { HandlerDeps } from '../types.js';
import type { SessionId } from '@mcp/session-storage';
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
const inflight = new Set<SessionId>();

export async function runAppLaunchStream(
  deps: HandlerDeps,
  sessionId: SessionId,
  emit: Emit,
  signal?: AbortSignal,
): Promise<void> {
  const session = await deps.appStudioStore.getSession(sessionId);
  if (!session) {
    emit({ event: 'error', data: { message: `App Studio session ${sessionId} not found.` } });
    return;
  }
  const revision = await deps.appStudioStore.getLatestPlanRevision(sessionId);
  const plan = parseAppPlan(revision?.plan_json ?? null);
  if (!revision || revision.status !== 'approved' || !plan) {
    emit({ event: 'error', data: { message: 'The current App plan must be approved before publishing.' } });
    return;
  }
  const fitness = auditAppPlan(plan);
  if (fitness.status !== 'ready') {
    emit({ event: 'error', data: { message: 'The current App plan is no longer ready to publish.' } });
    return;
  }
  const work = (await deps.appStudioStore.listWorkItems(sessionId)).filter(
    (item) => item.plan_revision_id === revision.id,
  );
  if (work.length === 0 || work.some((item) => item.status !== 'done')) {
    emit({ event: 'error', data: { message: 'All work and review cards for the approved plan must have current evidence.' } });
    return;
  }
  const project = deps.db.getProject(session.project_id);
  if (!project?.root_path) {
    emit({ event: 'error', data: { message: 'Workspace project missing.' } });
    return;
  }
  const workspaceFingerprint = appWorkspaceFingerprint(project.root_path);
  const evidenceCurrent = work.every((item) => {
    const records = (() => { try { return JSON.parse(item.evidence_json) as Array<{ plan_fingerprint?: string; workspace_fingerprint?: string }>; } catch { return []; } })();
    return records.some((record) => record.plan_fingerprint === fitness.plan_fingerprint && record.workspace_fingerprint === workspaceFingerprint);
  });
  if (!evidenceCurrent) {
    emit({ event: 'error', data: { message: 'Code or database files changed after the recorded evidence. Run the checks and review the affected cards again.' } });
    return;
  }
  if (inflight.has(sessionId)) {
    emit({ event: 'error', data: { message: 'A publish is already running for this app.' } });
    return;
  }
  inflight.add(sessionId);

  const workspaceDir = project.root_path;
  const onLog = (stream: 'stdout' | 'stderr', chunk: string) => emit({ event: 'log', data: { stream, chunk } });
  const phase = (id: string, label: string) => emit({ event: 'phase', data: { phase: id, label } });

  try {
    emit({ event: 'start', data: { app_slug: session.app_slug } });
    await deps.appStudioStore.saveDeployment({
      sessionId,
      planRevisionId: revision.id,
      status: 'publishing',
      detailsJson: JSON.stringify({ fitness_fingerprint: fitness.plan_fingerprint }),
    });

    phase('auth', 'Checking Cloudflare account');
    const who = await runWranglerWhoami(workspaceDir);
    if (!who.logged_in) {
      emit({ event: 'auth-required', data: { message: 'Not connected to Cloudflare — run the login flow first.' } });
      return;
    }

    let databaseId: string | null = null;
    if (plan.data.required) {
      const provisioner = getDatabaseProvisioner('d1');
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
    await deps.appStudioStore.saveDeployment({
      sessionId,
      planRevisionId: revision.id,
      status: healthy ? 'live' : 'failed',
      url,
      account: deployStatus.account,
      databaseId,
      healthOk: healthy,
      detailsJson: JSON.stringify({ deployed_at: deployStatus.deployed_at, fitness_fingerprint: fitness.plan_fingerprint }),
    });
    writeDeployStatus(workspaceDir, deployStatus);

    if (!healthy) {
      throw new Error(`Deployed to ${url} but the health check never turned green — open the app to inspect.`);
    }
    emit({ event: 'done', data: { deploy: deployStatus } });
  } catch (err) {
    try {
      await deps.appStudioStore.saveDeployment({
        sessionId,
        planRevisionId: revision.id,
        status: 'failed',
        detailsJson: JSON.stringify({ error: err instanceof Error ? err.message : String(err) }),
      });
    } catch { /* preserve the original publish error */ }
    emit({ event: 'error', data: { message: err instanceof Error ? err.message : String(err) } });
  } finally {
    inflight.delete(sessionId);
  }
}
