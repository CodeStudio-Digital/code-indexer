import type { HandlerDeps } from '../types.js';
import { resolveEffectiveMasterRuntime } from '@mcp/company/services/subordinate/role-runtime.js';

const APP_TEAM_ROLE_PRESET = [
  { role: 'research', tier: 'navigate' },
  { role: 'architect', tier: 'navigate' },
  { role: 'backend', tier: 'full' },
  { role: 'frontend', tier: 'full' },
  { role: 'database', tier: 'full' },
  { role: 'ux', tier: 'full' },
  { role: 'qa', tier: 'full' },
  { role: 'fullstack', tier: 'full' },
] as const;

export type AppTeamDeps = Pick<HandlerDeps, 'appStudioStore' | 'companyStore' | 'sessionStore'>;
export type CoderSession = NonNullable<ReturnType<HandlerDeps['sessionStore']['getSession']>>;

export interface AppTeamSessionView {
  runtime_kind: 'app_studio';
  state: 'ready';
  company_session_id: number;
  company_status: 'idle' | 'running' | 'paused' | 'completed' | 'error';
  master_session_id: number;
  master_agent_run_id: number;
}

export interface CreateAppTeamSessionResult {
  app_session: NonNullable<ReturnType<HandlerDeps['appStudioStore']['getSession']>>;
  team: AppTeamSessionView;
}

export function canonicalAppTeamRole(role: string): string {
  return role.trim().toLowerCase().slice(0, 80);
}

function masterRunInput(companySessionId: number, coordinator: CoderSession) {
  return {
    company_session_id: companySessionId,
    role: 'master',
    coder_session_id: coordinator.id,
    project_ids: [coordinator.project_id],
    provider: coordinator.provider,
    model: coordinator.model,
    configured_provider: coordinator.provider,
    configured_model: coordinator.model,
    dispatch_source: 'app_studio' as const,
  };
}

function initialTeamConfig(appSessionId: number, projectId: number, coordinator: CoderSession): Record<string, unknown> {
  const fallback = coordinator.fallback_provider && coordinator.fallback_model
    ? { provider: coordinator.fallback_provider, model: coordinator.fallback_model }
    : null;
  const roleAssignments = APP_TEAM_ROLE_PRESET.map(({ role, tier }) => ({
    role,
    provider: coordinator.provider,
    model: coordinator.model,
    tier,
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
    ...(coordinator.reasoning_effort_override ? { master_reasoning_effort: coordinator.reasoning_effort_override } : {}),
    ...(coordinator.temperature_override != null ? { master_temperature: coordinator.temperature_override } : {}),
    ...(coordinator.thinking_enabled ? { master_thinking: true } : {}),
    ...(fallback ? { master_fallback_provider: fallback.provider, master_fallback_model: fallback.model } : {}),
    role_assignments: roleAssignments,
    allowed_models: allowedModels,
  };
}

function teamView(deps: AppTeamDeps, appSessionId: number): AppTeamSessionView | null {
  const appSession = deps.appStudioStore.getSession(appSessionId);
  if (!appSession?.company_session_id) return null;
  const company = deps.companyStore.getCompanySession(appSession.company_session_id);
  if (!company || company.runtime_kind !== 'app_studio' || !company.master_session_id) return null;
  const masterRun = deps.companyStore.listAgentRuns(company.id)
    .filter((run) => run.role === 'master' && run.coder_session_id === company.master_session_id)
    .sort((a, b) => b.id - a.id)[0];
  if (!masterRun) return null;
  return {
    runtime_kind: 'app_studio',
    state: 'ready',
    company_session_id: company.id,
    company_status: company.status,
    master_session_id: company.master_session_id,
    master_agent_run_id: masterRun.id,
  };
}

export function getAppTeamSession(deps: AppTeamDeps, appSessionId: number): AppTeamSessionView | null {
  return teamView(deps, appSessionId);
}

/** Create exactly one fresh App-owned Company team. No adoption or repair path exists. */
export function createAppTeamSession(
  deps: AppTeamDeps,
  appSessionId: number,
  coordinatorSessionId: number,
): CreateAppTeamSessionResult {
  let appSession = deps.appStudioStore.getSession(appSessionId);
  if (!appSession) throw new Error(`App ${appSessionId} not found`);
  if (appSession.company_session_id != null) throw new Error(`App ${appSessionId} already has a team`);
  const coordinator = deps.sessionStore.getSession(coordinatorSessionId);
  if (!coordinator || coordinator.project_id !== appSession.project_id || coordinator.is_archived || coordinator.is_global) {
    throw new Error('The App Master must be a fresh active conversation from the App project');
  }
  deps.sessionStore.setSessionAgent(coordinator.id, 'app_orchestrator');

  const company = deps.companyStore.createCompanySession({
    name: appSession.name,
    runtime_kind: 'app_studio',
    config_json: JSON.stringify(initialTeamConfig(appSession.id, appSession.project_id, coordinator)),
  });
  try {
    deps.companyStore.addProjectToCompanySession(company.id, appSession.project_id);
    deps.companyStore.setMasterSessionId(company.id, coordinator.id);
    const claimed = deps.companyStore.getOrCreateAgentRun(masterRunInput(company.id, coordinator));
    appSession = deps.appStudioStore.setCompanySessionId(appSession.id, company.id);
    deps.appStudioStore.appendEvent(
      appSession.id,
      'team.created',
      'company_session',
      String(company.id),
      JSON.stringify({ master_session_id: coordinator.id, master_agent_run_id: claimed.run.id }),
      `app-team-created:${company.id}`,
    );
    return { app_session: appSession, team: teamView(deps, appSession.id)! };
  } catch (error) {
    try { deps.companyStore.deleteCompanySession(company.id); } catch { /* best effort */ }
    throw error;
  }
}

/** Apply the explicit Master runtime, including its configured provider fallback. */
export function normalizeAppMasterConversation(
  deps: AppTeamDeps,
  companyConfigJson: string,
  coordinator: CoderSession,
): CoderSession {
  const runtime = resolveEffectiveMasterRuntime({
    configJson: companyConfigJson,
    runtimeKind: 'app_studio',
    dispatchSource: 'app_studio',
  });
  if (coordinator.provider !== runtime.provider || coordinator.model !== runtime.model) {
    deps.sessionStore.updateSessionProvider(coordinator.id, runtime.provider, runtime.model);
    deps.sessionStore.setLastResponseState?.(coordinator.id, null, null);
  }
  deps.sessionStore.setSessionReasoningEffort?.(coordinator.id, runtime.reasoningEffort ?? null);
  deps.sessionStore.setSessionTemperature?.(coordinator.id, runtime.temperature ?? null);
  deps.sessionStore.setSessionThinkingEnabled?.(coordinator.id, runtime.thinking === true);
  deps.sessionStore.setSessionToolProfile?.(coordinator.id, 'navigate');
  const fallback = runtime.fallbackModels[0] ?? null;
  deps.sessionStore.setSessionFallback?.(coordinator.id, fallback?.provider ?? null, fallback?.model ?? null);
  return deps.sessionStore.getSession(coordinator.id) ?? coordinator;
}
