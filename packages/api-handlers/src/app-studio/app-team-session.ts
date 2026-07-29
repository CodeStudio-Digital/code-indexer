import type { HandlerDeps } from '../types.js';
import { resolveEffectiveMasterRuntime } from '@mcp/company/services/subordinate/role-runtime.js';
import { CompanySessionFiles } from '@mcp/company/services/CompanySessionFiles.js';
import type {
  AgentRunId,
  CompanySessionId,
  SessionId,
} from '@mcp/session-storage';
import { APP_TEAM_ROLE_PRESETS } from './app-team-presets.js';

const APP_TEAM_SPECIALIST_PRESETS = APP_TEAM_ROLE_PRESETS.filter((preset) => preset.role !== 'master');

export type AppTeamDeps = Pick<
  HandlerDeps,
  'appStudioStore' | 'operationalSessionFiles' | 'sessionStore'
>;
export type CoderSession = NonNullable<
  Awaited<ReturnType<HandlerDeps['sessionStore']['getSession']>>
>;

export interface AppTeamSessionView {
  runtime_kind: 'app_studio';
  state: 'ready';
  company_session_id: CompanySessionId;
  company_status: 'idle' | 'running' | 'paused' | 'completed' | 'error';
  master_session_id: SessionId;
  master_agent_run_id: AgentRunId;
}

export interface CreateAppTeamSessionResult {
  app_session: NonNullable<
    Awaited<ReturnType<HandlerDeps['appStudioStore']['getSession']>>
  >;
  team: AppTeamSessionView;
}

export function canonicalAppTeamRole(role: string): string {
  return role.trim().toLowerCase().slice(0, 80);
}

function masterRunInput(coordinator: CoderSession, projectId: number) {
  return {
    role: 'master',
    coder_session_id: coordinator.id,
    project_ids: [projectId],
    provider: coordinator.provider,
    model: coordinator.model,
    configured_provider: coordinator.provider,
    configured_model: coordinator.model,
    dispatch_source: 'app_studio' as const,
  };
}

function initialTeamConfig(
  appSessionId: SessionId,
  projectId: number,
  coordinator: CoderSession,
): Record<string, unknown> {
  const fallback = coordinator.fallback_provider && coordinator.fallback_model
    ? { provider: coordinator.fallback_provider, model: coordinator.fallback_model }
    : null;
  const roleAssignments = APP_TEAM_SPECIALIST_PRESETS.map(({ role, tier, systemPromptOverride, initialTools }) => ({
    role,
    provider: coordinator.provider,
    model: coordinator.model,
    tier,
    systemPromptOverride,
    initialTools: [...initialTools],
    projectIds: [projectId],
    enabled: true,
    ...(coordinator.temperature_override != null ? { temperature: coordinator.temperature_override } : {}),
    ...(coordinator.reasoning_effort_override ? { reasoningEffort: coordinator.reasoning_effort_override } : {}),
    ...(coordinator.thinking_enabled ? { thinking: true } : {}),
    ...(fallback ? { fallbackModels: [fallback] } : {}),
  }));
  const allowedModels = [{ provider: coordinator.provider, model: coordinator.model, label: 'App default', is_default: true }];
  if (fallback && (fallback.provider !== coordinator.provider || fallback.model !== coordinator.model)) {
    allowedModels.push({ ...fallback, label: 'Explicit fallback', is_default: false });
  }
  const masterPreset = APP_TEAM_ROLE_PRESETS.find((preset) => preset.role === 'master')!;
  return {
    runtime_kind: 'app_studio',
    app_session_id: appSessionId,
    work_source: 'app_studio_workflow',
    autonomy: {
      scheduler: true,
      orphanReset: false,
      autoApproveRoles: null,
      supervisorMaster: true,
      maxSubordinates: 8,
      freeze: false,
    },
    master_agent: 'app_orchestrator',
    master_enabled: true,
    master_provider: coordinator.provider,
    master_model: coordinator.model,
    master_tier: 'navigate',
    master_system_prompt_override: masterPreset.systemPromptOverride,
    master_initial_tools: [...masterPreset.initialTools],
    ...(coordinator.reasoning_effort_override ? { master_reasoning_effort: coordinator.reasoning_effort_override } : {}),
    ...(coordinator.temperature_override != null ? { master_temperature: coordinator.temperature_override } : {}),
    ...(coordinator.thinking_enabled ? { master_thinking: true } : {}),
    ...(fallback ? { master_fallback_provider: fallback.provider, master_fallback_model: fallback.model } : {}),
    role_assignments: roleAssignments,
    allowed_models: allowedModels,
  };
}

function companyStatus(
  value: string,
): AppTeamSessionView['company_status'] {
  return value === 'running' ||
    value === 'paused' ||
    value === 'completed' ||
    value === 'error'
    ? value
    : 'idle';
}

async function teamView(
  deps: AppTeamDeps,
  appSessionId: SessionId,
): Promise<AppTeamSessionView | null> {
  const appSession = await deps.appStudioStore.getSession(appSessionId);
  if (!appSession?.company_session_id) return null;
  const company = await deps.operationalSessionFiles.getCompanySession(
    appSession.company_session_id,
  );
  if (!company || company.runtime_kind !== 'app_studio' || !company.master_session_id) return null;
  const files = new CompanySessionFiles({
    companySessionId: company.id,
    sessionStore: deps.sessionStore,
  });
  const masterRun = (await files.listAgentRuns())
    .filter((run) => run.role === 'master' && run.coder_session_id === company.master_session_id)
    .sort(
      (a, b) =>
        Date.parse(b.created_at) - Date.parse(a.created_at),
    )[0];
  if (!masterRun) return null;
  return {
    runtime_kind: 'app_studio',
    state: 'ready',
    company_session_id: company.id,
    company_status: companyStatus(company.status),
    master_session_id: company.master_session_id,
    master_agent_run_id: masterRun.id,
  };
}

export function getAppTeamSession(
  deps: AppTeamDeps,
  appSessionId: SessionId,
): Promise<AppTeamSessionView | null> {
  return teamView(deps, appSessionId);
}

/** Create exactly one fresh App-owned Company team. No adoption or repair path exists. */
export async function createAppTeamSession(
  deps: AppTeamDeps,
  appSessionId: SessionId,
  coordinatorSessionId: SessionId,
): Promise<CreateAppTeamSessionResult> {
  let appSession = await deps.appStudioStore.getSession(appSessionId);
  if (!appSession) throw new Error(`App ${appSessionId} not found`);
  if (appSession.company_session_id != null) throw new Error(`App ${appSessionId} already has a team`);
  const coordinator = await deps.sessionStore.getSession(coordinatorSessionId);
  if (!coordinator || coordinator.project_id !== appSession.project_id || coordinator.is_archived || coordinator.is_global) {
    throw new Error('The App Master must be a fresh active conversation from the App project');
  }
  await deps.sessionStore.setSessionAgent(coordinator.id, 'app_orchestrator');

  const company = await deps.operationalSessionFiles.createCompanySession({
    name: appSession.name,
    project_ids: [appSession.project_id],
    runtime_kind: 'app_studio',
    config_json: JSON.stringify(initialTeamConfig(appSession.id, appSession.project_id, coordinator)),
  });
  try {
    const files = new CompanySessionFiles({
      companySessionId: company.id,
      sessionStore: deps.sessionStore,
    });
    await files.setMasterSessionId(coordinator.id);
    const existing = (await files.listAgentRuns()).find(
      (run) =>
        run.role === 'master' &&
        run.coder_session_id === coordinator.id,
    );
    const masterRun =
      existing ??
      (await files.createAgentRun(
        masterRunInput(coordinator, appSession.project_id),
      ));
    appSession = await deps.appStudioStore.setCompanySessionId(
      appSession.id,
      company.id,
    );
    await deps.appStudioStore.appendEvent(
      appSession.id,
      'team.created',
      'company_session',
      String(company.id),
      JSON.stringify({
        master_session_id: coordinator.id,
        master_agent_run_id: masterRun.id,
      }),
      `app-team-created:${company.id}`,
    );
    return {
      app_session: appSession,
      team: (await teamView(deps, appSession.id))!,
    };
  } catch (error) {
    try {
      await deps.operationalSessionFiles.deleteCompanySession(company.id);
    } catch {
      /* best effort */
    }
    throw error;
  }
}

/** Apply the explicit Master runtime, including its configured provider fallback. */
export async function normalizeAppMasterConversation(
  deps: AppTeamDeps,
  companyConfigJson: string,
  coordinator: CoderSession,
): Promise<CoderSession> {
  const runtime = resolveEffectiveMasterRuntime({
    configJson: companyConfigJson,
    runtimeKind: 'app_studio',
    dispatchSource: 'app_studio',
  });
  if (coordinator.provider !== runtime.provider || coordinator.model !== runtime.model) {
    await deps.sessionStore.updateSessionProvider(
      coordinator.id,
      runtime.provider,
      runtime.model,
    );
    await deps.sessionStore.setLastResponseState?.(
      coordinator.id,
      null,
      null,
    );
  }
  await deps.sessionStore.setSessionReasoningEffort?.(
    coordinator.id,
    runtime.reasoningEffort ?? null,
  );
  await deps.sessionStore.setSessionTemperature?.(
    coordinator.id,
    runtime.temperature ?? null,
  );
  await deps.sessionStore.setSessionThinkingEnabled?.(
    coordinator.id,
    runtime.thinking === true,
  );
  await deps.sessionStore.setSessionToolProfile?.(
    coordinator.id,
    'navigate',
  );
  const fallback = runtime.fallbackModels[0] ?? null;
  await deps.sessionStore.setSessionFallback?.(
    coordinator.id,
    fallback?.provider ?? null,
    fallback?.model ?? null,
  );
  return (await deps.sessionStore.getSession(coordinator.id)) ?? coordinator;
}
