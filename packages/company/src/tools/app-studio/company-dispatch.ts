import type { AppRoleRuntime, AppSubordinateSnapshot, AppDispatchCapacity, AppCompanyDispatchHost, AppCompanyDispatchResult, AppWorkItem } from './company-dispatch-types.js';
export type { AppRoleRuntime, AppSubordinateSnapshot, AppDispatchCapacity, AppAgentRuntimeProvenance, AppCompanyDispatchHost, AppCompanyDispatchResult } from './company-dispatch-types.js';
import { createHash } from 'node:crypto';
import type { AppStudioSession, AppStudioStore, AppStudioWorkItem } from '@mcp/store/app-studio-store.js';

import type { SessionId } from '@mcp/session-storage';

function json<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;
  try { return JSON.parse(value) as T; } catch { return fallback; }
}

function hydrateItem(row: AppStudioWorkItem): AppWorkItem {
  return {
    ...row,
    depends_on: json(row.depends_on_json, []),
    source_ids: json(row.source_ids_json, []),
    acceptance: json(row.acceptance_json, []),
    evidence: json(row.evidence_json, []),
    file_scope: json(row.file_scope_json, []),
  };
}

function defaultRoleFor(item: AppWorkItem): string {
  switch (item.kind) {
    case 'research': return 'research';
    case 'plan': return 'architect';
    case 'verify':
    case 'release': return 'qa';
    case 'contract': return 'backend';
    case 'implement':
    case 'change': return 'fullstack';
  }
}

export function normalizeAppWorkRole(item: AppWorkItem, _host: AppCompanyDispatchHost): string {
  const requested = item.owner_role.trim().toLowerCase();
  if (!requested || requested === 'coordinator' || requested === 'master') return defaultRoleFor(item);
  return requested;
}

function runtimeHash(role: string, runtime: AppRoleRuntime): string {
  return createHash('sha256').update(JSON.stringify({
    role,
    provider: runtime.provider ?? null,
    model: runtime.model ?? null,
    tier: runtime.tier ?? null,
    reasoningEffort: runtime.reasoningEffort ?? null,
    thinking: runtime.thinking ?? null,
    thinkingBudgetTokens: runtime.thinkingBudgetTokens ?? null,
    temperature: runtime.temperature ?? null,
    skills: runtime.skills ?? null,
    systemPromptOverride: runtime.systemPromptOverride ?? null,
    fallbackModels: runtime.fallbackModels ?? null,
  })).digest('hex');
}

function taskFor(item: AppWorkItem): string {
  const lines = [
    `[APP WORK ITEM ${item.id}] ${item.title}`,
    '',
    item.outcome,
    `Approved plan revision: ${item.plan_revision_id}`,
    item.slice_id ? `Slice: ${item.slice_id}` : null,
    item.acceptance.length ? `Acceptance:\n- ${item.acceptance.join('\n- ')}` : 'Acceptance: no explicit criteria',
    item.source_ids.length ? `Sources:\n- ${item.source_ids.join('\n- ')}` : null,
    item.file_scope.length ? `File scope:\n- ${item.file_scope.join('\n- ')}` : 'File scope: discover the narrowest safe scope before editing.',
    '',
    `Before finishing, call app_record_work_evidence({work_item_id:"${item.id}", ...}) with concrete proof. ` +
      'If blocked, record status=blocked and the exact reason.',
  ];
  return lines.filter((line): line is string => line != null).join('\n');
}

async function runtimeEventPayload(
  host: AppCompanyDispatchHost,
  agentRunId: string,
  configured: AppRoleRuntime,
): Promise<Record<string, unknown>> {
  const persisted = await host.getAppAgentRuntimeProvenance(agentRunId);
  return {
    configured_provider: persisted?.configuredProvider ?? configured.provider ?? null,
    configured_model: persisted?.configuredModel ?? configured.model ?? null,
    effective_provider: persisted?.effectiveProvider ?? configured.provider ?? null,
    effective_model: persisted?.effectiveModel ?? configured.model ?? null,
    dispatch_source: persisted?.dispatchSource ?? 'app_studio',
    fallback_reason: persisted?.fallbackReason ?? null,
  };
}

function fileScopesConflict(a: AppWorkItem, b: AppWorkItem): boolean {
  if (a.file_scope.length === 0 || b.file_scope.length === 0) {
    return a.kind === 'implement' && b.kind === 'implement';
  }
  return a.file_scope.some((left) => b.file_scope.some((right) =>
    left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`),
  ));
}

const dispatchingReusableAgents = new Set<string>();

async function findReusableAgent(args: {
  store: AppStudioStore;
  session: AppStudioSession;
  host: AppCompanyDispatchHost;
  role: string;
  projectId: number;
  runtime: AppRoleRuntime;
  runtimeConfigHash: string;
}): Promise<AppSubordinateSnapshot | null> {
  if (!args.runtime.provider || !args.runtime.model) return null;
  const priorRuns = await args.store.listWorkItemRuns(
    args.session.id,
    { limit: 1_000 },
  );
  return (await args.host.listSubordinates()).find((agent) =>
    !dispatchingReusableAgents.has(agent.agentRunId)
    && agent.role === args.role
    && agent.status === 'waiting'
    && agent.projectIds.includes(args.projectId)
    && agent.provider === args.runtime.provider
    && agent.model === args.runtime.model
    && priorRuns.some((run) =>
      run.company_agent_run_id === agent.agentRunId
      && run.runtime_config_hash === args.runtimeConfigHash
    )
  ) ?? null;
}

function capacitySkipDetail(
  capacity: AppDispatchCapacity,
  reusesExistingAgent: boolean,
): string | null {
  if (capacity.activeConcurrent >= capacity.concurrencyLimit) {
    return `App team concurrency is full (${capacity.activeConcurrent}/${capacity.concurrencyLimit}); card remains ready.`;
  }
  if (
    !reusesExistingAgent
    && capacity.maxSubordinates != null
    && capacity.activeSubordinates >= capacity.maxSubordinates
  ) {
    return `Company subordinate budget is full (${capacity.activeSubordinates}/${capacity.maxSubordinates}); card remains ready.`;
  }
  return null;
}

function isCapacityRefusal(message: string): boolean {
  const normalized = message.toLowerCase();
  return normalized.includes('concurrent subordinate cap reached')
    || normalized.includes('global subordinate budget reached');
}

function isMutationOutcomeUnknown(error: unknown): boolean {
  return (
    typeof error === 'object'
    && error !== null
    && (
      (error as { code?: unknown }).code === 'port_closed'
      || (error as { code?: unknown }).code === 'request_timeout'
      || (error as { code?: unknown }).code === 'unserializable_response'
    )
  );
}

async function openDecisionWorkItemIds(
  store: AppStudioStore,
  sessionId: SessionId,
): Promise<Set<string>> {
  const blocked = new Set<string>();
  for (const decision of await store.listDecisions(sessionId)) {
    if (decision.status !== 'open') continue;
    for (const id of json<string[]>(decision.blocked_work_item_ids_json, [])) blocked.add(id);
  }
  return blocked;
}

async function blockWorkItem(
  store: AppStudioStore,
  session: AppStudioSession,
  item: AppWorkItem,
  reason: string,
): Promise<void> {
  await store.setWorkItemStatus(
    session.id,
    item.id,
    'blocked',
    { blockedReason: reason },
  );
}

async function dispatchOneUnlocked(args: {
  store: AppStudioStore;
  session: AppStudioSession;
  host: AppCompanyDispatchHost;
  item: AppWorkItem;
  source: string;
}): Promise<AppCompanyDispatchResult> {
  const { store, session, host, item } = args;
  let active = await store.getActiveWorkItemRun(session.id, item.id);
  if (
    active
    && active.company_agent_run_id == null
    && active.status_message?.startsWith('OUTCOME_UNKNOWN:')
  ) {
    return {
      workItemId: item.id,
      role: active.role,
      outcome: 'blocked',
      code: 'OUTCOME_UNKNOWN',
      workItemRunId: active.id,
      detail: active.status_message,
    };
  }
  if (active?.company_agent_run_id != null) {
    return {
      workItemId: item.id,
      role: active.role,
      outcome: 'skipped',
      workItemRunId: active.id,
      companyAgentRunId: active.company_agent_run_id ?? undefined,
      coderSessionId: active.coder_session_id ?? undefined,
      detail: `attempt ${active.attempt} is already ${active.status}`,
    };
  }

  const role = normalizeAppWorkRole(item, host);
  const runtime = await host.getRoleDefaults(role);
  if (!runtime) {
    const reason = `No configured Company role '${role}' for App work item '${item.id}'.`;
    await blockWorkItem(store, session, item, reason);
    return { workItemId: item.id, role, outcome: 'blocked', detail: reason };
  }
  if (runtime.enabled === false) {
    const reason = `Company role '${role}' is disabled; enable or reassign it before dispatch.`;
    await blockWorkItem(store, session, item, reason);
    return { workItemId: item.id, role, outcome: 'blocked', detail: reason };
  }
  if (!runtime.provider || !runtime.model) {
    const reason = `Company role '${role}' has no explicit provider/model. Silent fallback is forbidden for App teams.`;
    await blockWorkItem(store, session, item, reason);
    return { workItemId: item.id, role, outcome: 'blocked', detail: reason };
  }

  const configHash = runtimeHash(role, runtime);
  if (
    active
    && (
      active.role !== role
      || (active.runtime_config_hash != null && active.runtime_config_hash !== configHash)
    )
  ) {
    await store.updateWorkItemRunStatus(active.id, 'interrupted', {
      statusMessage: 'Unbound claim superseded because the App role runtime changed.',
    });
    active = null;
  }
  const reusable = await findReusableAgent({
    store,
    session,
    host,
    role,
    projectId: session.project_id,
    runtime,
    runtimeConfigHash: configHash,
  });
  const capacityDetail = capacitySkipDetail(
    await host.getAppDispatchCapacity(),
    reusable != null,
  );
  if (capacityDetail) {
    return { workItemId: item.id, role, outcome: 'skipped', detail: capacityDetail };
  }

  const attempt =
    active?.attempt ??
    await store.nextWorkItemRunAttempt(session.id, item.id);
  let workRun = active ?? await store.createWorkItemRun({
      appSessionId: session.id,
      workItemId: item.id,
      attempt,
      role,
      status: 'claimed',
      runtimeConfigHash: configHash,
      idempotencyKey: `app:${session.id}:work:${item.id}:attempt:${attempt}`,
  });
  if (active) {
    workRun = await store.updateWorkItemRunStatus(active.id, 'claimed', {
      runtimeConfigHash: configHash,
      statusMessage: `reclaimed unbound attempt ${attempt} from ${args.source}`,
    });
  }
  const task = taskFor(item);
  if (reusable) dispatchingReusableAgents.add(reusable.agentRunId);

  try {
    if (reusable) {
      const resumed = await host.reactivateSubordinate(
        reusable.agentRunId,
        task,
        undefined,
        runtime.thinking,
      );
      if (resumed) {
        workRun = await store.updateWorkItemRunStatus(workRun.id, 'running', {
          companyAgentRunId: reusable.agentRunId,
          coderSessionId: reusable.coderSessionId,
          runtimeConfigHash: configHash,
          statusMessage: `reused ${role} agent from ${args.source}`,
        });
        await store.setWorkItemStatus(session.id, item.id, 'running');
        await store.appendEvent(
          session.id,
          'agents.specialist_dispatched',
          'work_item_run',
          String(workRun.id),
          JSON.stringify({
            work_item_id: item.id,
            attempt,
            role,
            outcome: 'reused',
            company_agent_run_id: reusable.agentRunId,
            coder_session_id: reusable.coderSessionId,
            source: args.source,
            ...await runtimeEventPayload(host, reusable.agentRunId, runtime),
          }),
          `app-specialist-dispatched:${workRun.id}:reused`,
        );
        return {
          workItemId: item.id, role, outcome: 'reused', workItemRunId: workRun.id,
          companyAgentRunId: reusable.agentRunId, coderSessionId: reusable.coderSessionId,
        };
      }
      // The waiting agent changed state between selection and reactivation.
      // A fresh spawn needs a global slot of its own, so re-check before
      // falling through instead of turning capacity pressure into a failure.
      const spawnCapacityDetail = capacitySkipDetail(
        await host.getAppDispatchCapacity(),
        false,
      );
      if (spawnCapacityDetail) {
        await store.updateWorkItemRunStatus(workRun.id, 'cancelled', { statusMessage: spawnCapacityDetail });
        return {
          workItemId: item.id,
          role,
          outcome: 'skipped',
          workItemRunId: workRun.id,
          detail: spawnCapacityDetail,
        };
      }
    }

    const spawned = await host.spawnSubordinate({
      role,
      task,
      projectId: session.project_id,
      wait: false,
      dispatchSource: 'app_studio',
    });
    workRun = await store.updateWorkItemRunStatus(workRun.id, 'running', {
      companyAgentRunId: spawned.agentRunId,
      coderSessionId: spawned.coderSessionId,
      runtimeConfigHash: configHash,
      statusMessage: `spawned ${role} agent from ${args.source}`,
    });
    await store.setWorkItemStatus(session.id, item.id, 'running');
    await store.appendEvent(
      session.id,
      'agents.specialist_dispatched',
      'work_item_run',
      String(workRun.id),
      JSON.stringify({
        work_item_id: item.id,
        attempt,
        role,
        outcome: 'spawned',
        company_agent_run_id: spawned.agentRunId,
        coder_session_id: spawned.coderSessionId,
        source: args.source,
        ...await runtimeEventPayload(host, spawned.agentRunId, runtime),
      }),
      `app-specialist-dispatched:${workRun.id}:spawned`,
    );
    return {
      workItemId: item.id, role, outcome: 'spawned', workItemRunId: workRun.id,
      companyAgentRunId: spawned.agentRunId, coderSessionId: spawned.coderSessionId,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (isMutationOutcomeUnknown(error)) {
      const detail =
        `OUTCOME_UNKNOWN: App specialist dispatch lost its worker acknowledgement. ` +
        `Attempt ${attempt} remains claimed and will not be spawned again automatically.`;
      await store.updateWorkItemRunStatus(workRun.id, 'claimed', { statusMessage: detail });
      try {
        await store.appendEvent(
          session.id,
          'agents.specialist_dispatch_outcome_unknown',
          'work_item_run',
          String(workRun.id),
          JSON.stringify({
            work_item_id: item.id,
            attempt,
            role,
            source: args.source,
            code: 'OUTCOME_UNKNOWN',
          }),
          `app-specialist-dispatch-outcome-unknown:${workRun.id}`,
        );
      } catch { /* the claimed run remains the durable replay fence */ }
      return {
        workItemId: item.id,
        role,
        outcome: 'blocked',
        code: 'OUTCOME_UNKNOWN',
        workItemRunId: workRun.id,
        detail,
      };
    }
    if (isCapacityRefusal(message)) {
      await store.updateWorkItemRunStatus(workRun.id, 'cancelled', { statusMessage: message });
      return {
        workItemId: item.id,
        role,
        outcome: 'skipped',
        workItemRunId: workRun.id,
        detail: `${message} Card remains ready and can be retried.`,
      };
    }
    await store.updateWorkItemRunStatus(workRun.id, 'error', { statusMessage: message });
    await blockWorkItem(store, session, item, message);
    return { workItemId: item.id, role, outcome: 'blocked', workItemRunId: workRun.id, detail: message };
  } finally {
    if (reusable) dispatchingReusableAgents.delete(reusable.agentRunId);
  }
}

const dispatchingWorkItems = new Set<string>();

async function dispatchOne(args: Parameters<typeof dispatchOneUnlocked>[0]): Promise<AppCompanyDispatchResult> {
  const key = `${args.session.id}:${args.item.id}`;
  if (dispatchingWorkItems.has(key)) {
    return {
      workItemId: args.item.id,
      role: args.item.owner_role,
      outcome: 'skipped',
      detail: 'dispatch is already being claimed by this App team',
    };
  }
  dispatchingWorkItems.add(key);
  try {
    return await dispatchOneUnlocked(args);
  } finally {
    dispatchingWorkItems.delete(key);
  }
}

/** Dispatch only the first conflict-free wave; later waves wait for evidence. */
export async function dispatchReadyAppWork(args: {
  store: AppStudioStore;
  session: AppStudioSession;
  host: AppCompanyDispatchHost;
  source: 'master_tool' | 'scheduler' | 'manual';
  maxItems?: number;
}): Promise<AppCompanyDispatchResult[]> {
  if (args.session.company_session_id == null) return [];
  const items = (await args.store.refreshReadyWorkItems(args.session.id))
    .map(hydrateItem);
  const runningItems = items.filter((item) => item.status === 'running');
  const [decisionBlockedIds, approvedPlan] = await Promise.all([
    openDecisionWorkItemIds(args.store, args.session.id),
    args.store.getLatestApprovedPlanRevision(args.session.id),
  ]);
  const limit = Math.max(1, Math.min(8, args.maxItems ?? 8));
  const selected: AppWorkItem[] = [];
  for (const item of items) {
    if (selected.length >= limit) break;
    if (
      item.status !== 'ready' ||
      approvedPlan?.id !== item.plan_revision_id
    ) continue;
    if (decisionBlockedIds.has(item.id)) continue;
    if ([...runningItems, ...selected].some((other) => fileScopesConflict(item, other))) continue;
    selected.push(item);
  }
  const results: AppCompanyDispatchResult[] = [];
  for (const item of selected) results.push(await dispatchOne({ ...args, item }));
  return results;
}

export { reconcileAppWorkItemRuns } from './company-reconcile.js';
