import type { AppStudioWorkItem, UpsertAppStudioWorkItemInput } from '@mcp/store/app-studio-store.js';
import { parseAppPlan, type AppFitnessReport, type AppPlanV1 } from '@mcp/app-studio/plan/types.js';
import type { ServerDeps } from '../../deps.js';
import { type SessionId } from '@mcp/session-storage';
import { getAppTeamSession } from '@mcp/api-handlers/app-studio/app-team-session.js';
import { appWorkspaceFingerprint } from '@mcp/app-studio/plan/evidence.js';

type AppStage = 'planning' | 'building' | 'reviewing' | 'ready' | 'live';

function json<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback;
  try { return JSON.parse(raw) as T; } catch { return fallback; }
}

function workView(row: AppStudioWorkItem) {
  const { depends_on_json, source_ids_json, acceptance_json, evidence_json, file_scope_json, ...plain } = row;
  return {
    ...plain,
    depends_on: json<string[]>(depends_on_json, []),
    source_ids: json<string[]>(source_ids_json, []),
    acceptance: json<string[]>(acceptance_json, []),
    evidence: json<Array<Record<string, unknown>>>(evidence_json, []),
    file_scope: json<string[]>(file_scope_json, []),
  };
}

function deriveStage(args: {
  approved: boolean;
  fitness: AppFitnessReport | null;
  work: AppStudioWorkItem[];
  openDecisions: number;
  live: boolean;
  evidenceCurrent: boolean;
}): AppStage {
  if (args.live) return 'live';
  if (!args.approved) return args.openDecisions > 0 || args.fitness?.status === 'needs_decision' ? 'reviewing' : 'planning';
  if (args.openDecisions > 0 || args.work.some((item) => item.status === 'review' || item.status === 'blocked')) return 'reviewing';
  if (args.work.length > 0 && args.work.every((item) => item.status === 'done')) return args.evidenceCurrent ? 'ready' : 'reviewing';
  return 'building';
}

async function recentEventViews(
  deps: ServerDeps,
  id: SessionId,
  limit = 50,
) {
  const recent: Awaited<
    ReturnType<ServerDeps['appStudioStore']['listEvents']>
  > = [];
  let cursor = 0;
  for (;;) {
    const batch = await deps.appStudioStore.listEvents(id, cursor);
    if (batch.length === 0) break;
    recent.push(...batch);
    if (recent.length > limit) recent.splice(0, recent.length - limit);
    const nextCursor = batch[batch.length - 1]!.seq;
    if (nextCursor <= cursor || batch.length < 250) break;
    cursor = nextCursor;
  }
  return recent.map((event) => ({
    id: event.id,
    seq: event.seq,
    event_type: event.kind,
    payload: json<unknown>(event.payload_json, {}),
    created_at: event.created_at,
  }));
}

export async function appState(
  deps: ServerDeps,
  id: SessionId,
  options: { includeRecentEvents?: boolean } = {},
) {
  const session = await deps.appStudioStore.getSession(id);
  if (!session) return null;
  const project = deps.db.getProject(session.project_id);
  const builder = json<{ port?: number }>(project?.builder_json, {});
  const [
    revision,
    work,
    workRuns,
    decisions,
    deployment,
    planHistory,
    team,
  ] = await Promise.all([
    deps.appStudioStore.getLatestPlanRevision(id),
    deps.appStudioStore.listWorkItems(id),
    deps.appStudioStore.listWorkItemRuns(id, { limit: 250 }),
    deps.appStudioStore.listDecisions(id),
    deps.appStudioStore.getLatestDeployment(id),
    deps.appStudioStore.listPlanRevisions(id),
    getAppTeamSession(deps, id),
  ]);
  const plan = parseAppPlan(revision?.plan_json ?? null);
  const fitness = json<AppFitnessReport | null>(revision?.fitness_json, null);
  const currentWork = work.filter((item) => (
    item.plan_revision_id === revision?.id && !['cancelled', 'stale'].includes(item.status)
  ));
  const workRunsByItem = new Map<string, typeof workRuns>();
  for (const run of workRuns) {
    const attempts = workRunsByItem.get(run.work_item_id) ?? [];
    if (attempts.length < 3) attempts.push(run);
    workRunsByItem.set(run.work_item_id, attempts);
  }
  const evidenceCurrent = (() => {
    if (!project?.root_path || !fitness || currentWork.length === 0 || !currentWork.every((item) => item.status === 'done')) return false;
    const workspace = appWorkspaceFingerprint(project.root_path);
    return currentWork.every((item) => json<Array<{ plan_fingerprint?: string; workspace_fingerprint?: string }>>(item.evidence_json, [])
      .some((record) => record.plan_fingerprint === fitness.plan_fingerprint && record.workspace_fingerprint === workspace));
  })();
  return {
    session,
    project: project ? { id: project.id, name: project.name, root_path: project.root_path } : null,
    builder_port: typeof builder.port === 'number' ? builder.port : null,
    stage: deriveStage({
      approved: revision?.status === 'approved',
      fitness,
      work: currentWork,
      openDecisions: decisions.filter((item) => item.status === 'open').length,
      live: deployment?.status === 'live' && deployment.health_ok === 1,
      evidenceCurrent,
    }),
    plan_revision: revision ? {
      ...revision,
      plan,
      fitness,
      plan_json: undefined,
      fitness_json: undefined,
    } : null,
    plan_history: planHistory.map((item) => ({
      id: item.id,
      revision_number: item.revision_number,
      status: item.status,
      created_by: item.created_by,
      created_at: item.created_at,
      approved_at: item.approved_at,
    })),
    work_items: work.map((item) => {
      const attempts = workRunsByItem.get(item.id) ?? [];
      return {
        ...workView(item),
        latest_attempt: attempts[0] ?? null,
        active_attempt: attempts.find((attempt) => (
          ['claimed', 'running', 'waiting', 'paused'].includes(attempt.status)
        )) ?? null,
        attempts,
      };
    }),
    decisions: decisions.map(({ options_json, blocked_work_item_ids_json, ...decision }) => ({
      ...decision,
      options: json<unknown[]>(options_json, []),
      blocked_work_item_ids: json<string[]>(blocked_work_item_ids_json, []),
    })),
    deployment,
    evidence_current: evidenceCurrent,
    team,
    master_session_id: team?.master_session_id ?? null,
    ...(options.includeRecentEvents
      ? { recent_events: await recentEventViews(deps, id) }
      : {}),
  };
}

export function workFromPlan(
  appSessionId: SessionId,
  revisionId: string,
  plan: AppPlanV1,
): UpsertAppStudioWorkItemInput[] {
  const items: UpsertAppStudioWorkItemInput[] = [];
  for (const [index, slice] of plan.delivery.slices.entries()) {
    const tests = plan.delivery.tests.filter((test) => slice.test_ids.includes(test.id));
    const implementId = `slice:${slice.id}:implement`;
    items.push({
      app_session_id: appSessionId,
      id: implementId,
      plan_revision_id: revisionId,
      slice_id: slice.id,
      title: `Construir ${slice.name}`,
      outcome: `Entregar o slice '${slice.name}' do plano aprovado.`,
      kind: 'implement',
      owner_role: 'fullstack',
      priority: 100 - index,
      sort_order: index * 2,
      status: 'backlog',
      depends_on_json: JSON.stringify(slice.depends_on.map((id) => `slice:${id}:verify`)),
      source_ids_json: JSON.stringify(slice.capability_ids),
      acceptance_json: JSON.stringify(tests.map((test) => `${test.title}: ${test.expected}`)),
    });
    items.push({
      app_session_id: appSessionId,
      id: `slice:${slice.id}:verify`,
      plan_revision_id: revisionId,
      slice_id: slice.id,
      title: `Revisar ${slice.name}`,
      outcome: `Provar que o slice '${slice.name}' atende à revisão aprovada.`,
      kind: 'verify',
      owner_role: 'qa',
      priority: 90 - index,
      sort_order: index * 2 + 1,
      status: 'backlog',
      depends_on_json: JSON.stringify([implementId]),
      source_ids_json: JSON.stringify([...slice.capability_ids, ...slice.test_ids]),
      acceptance_json: JSON.stringify(tests.map((test) => `${test.title}: ${test.expected}`)),
    });
  }
  return items;
}
