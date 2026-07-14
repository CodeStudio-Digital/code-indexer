import type { Hono } from 'hono';
import { parseAppAgentConfig, serializeAppAgentConfig } from '@mcp/app-studio/workflow/agent-config.js';
import { parseIdParam, parseJsonBody, notFound } from '../_helpers.js';
import type { ServerDeps } from '../../deps.js';
import { getAppWorkflowView } from './workflow-service.js';

const assignedSkills = (config: ReturnType<typeof parseAppAgentConfig>): Set<string> => new Set([
  ...config.coordinator_skills,
  ...Object.values(config.profiles).flatMap((profile) => profile.skills),
]);

function availableSkills(deps: ServerDeps, projectId: number) {
  const byId = new Map([
    ...deps.skillStore.listSkills({ scope: 'global' }),
    ...deps.skillStore.listSkills({ scope: String(projectId) }),
  ].map((skill) => [skill.id, skill]));
  return [...byId.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export function mountAppStudioAgentRoutes(app: Hono, deps: ServerDeps): void {
  app.get('/api/app-studio/sessions/:id/agents', (c) => {
    const id = parseIdParam(c);
    const session = deps.appStudioStore.getSession(id);
    if (!session) return notFound(c);
    const workflow = getAppWorkflowView(deps, id);
    const coordinatorId = workflow?.coordinator_session_id ?? session.coordinator_session_id;
    const coordinator = coordinatorId ? deps.sessionStore.getSession(coordinatorId) : null;
    const runs = coordinatorId ? deps.sessionStore.listSubagentRuns(coordinatorId, 60) : [];
    const config = parseAppAgentConfig(session.agent_config_json);
    const profileNames = [...new Set([
      'research', 'plan', 'implement', 'verify',
      ...(workflow?.work_items.map((item) => item.owner_profile) ?? []),
      ...Object.keys(config.profiles),
    ])].filter(Boolean).sort();
    const workItems = workflow?.work_items ?? [];
    const skills = availableSkills(deps, session.project_id);
    return c.json({
      config,
      coordinator: coordinator ? {
        id: coordinator.id,
        title: coordinator.title,
        status: coordinator.status,
        provider: coordinator.provider,
        model: coordinator.model,
        agent: coordinator.agent,
        total_input_tokens: coordinator.total_input_tokens,
        total_output_tokens: coordinator.total_output_tokens,
        last_turn_input_tokens: coordinator.last_turn_input_tokens,
        tool_permission_mode: coordinator.tool_permission_mode,
        reasoning_effort: coordinator.reasoning_effort_override,
        created_at: coordinator.created_at,
        updated_at: coordinator.updated_at,
      } : null,
      profiles: profileNames.map((name) => ({
        name,
        enabled: config.profiles[name]?.enabled !== false,
        additional_prompt: config.profiles[name]?.additional_prompt ?? '',
        skills: config.profiles[name]?.skills ?? [],
        cards: workItems.filter((item) => item.owner_profile === name).length,
        active_cards: workItems.filter((item) => item.owner_profile === name && ['ready', 'running', 'review', 'blocked'].includes(item.status)).length,
        runs: runs.filter((run) => run.profile === name).length,
      })),
      runs: runs.map((run) => ({
        ...run,
        tool_calls_detail: deps.sessionStore.listSubagentToolCalls(run.run_id, 80),
      })),
      available_skills: skills.map((skill) => ({
        id: skill.id,
        name: skill.name,
        description: skill.description,
        slash_command: skill.slash_command,
        context_mode: skill.context_mode,
        source: skill.source,
        author: skill.author,
      })),
    });
  });

  app.patch('/api/app-studio/sessions/:id/agents/runtime', async (c) => {
    const id = parseIdParam(c);
    const session = deps.appStudioStore.getSession(id);
    if (!session) return notFound(c);
    const body = await parseJsonBody<{ provider?: unknown; model?: unknown; reasoning_effort?: unknown }>(c);
    const provider = typeof body.provider === 'string' ? body.provider.trim() : '';
    const model = typeof body.model === 'string' ? body.model.trim() : '';
    const reasoningEffort = body.reasoning_effort == null
      ? null
      : typeof body.reasoning_effort === 'string'
        ? body.reasoning_effort.trim() || null
        : undefined;
    if (!provider || !model || reasoningEffort === undefined) {
      return c.json({ error: 'provider, model and reasoning_effort:string|null are required' }, 400);
    }

    const configuredProviders = deps.providerStore.listProviders({ enabled: true, use_for_coder: true });
    if (configuredProviders.length > 0 && !configuredProviders.some((candidate) => candidate.id === provider)) {
      return c.json({ error: `provider '${provider}' is not enabled for coder sessions` }, 400);
    }
    const [bareModel, requestedMode] = model.split('::');
    const models = deps.providerStore.listModels(provider, true);
    const selectedModel = models.find((candidate) => candidate.model_id === bareModel && (!requestedMode || candidate.mode === requestedMode))
      ?? models.find((candidate) => candidate.model_id === bareModel);
    if (models.length > 0 && !selectedModel) {
      return c.json({ error: `model '${model}' is not enabled for provider '${provider}'` }, 400);
    }
    const supported = selectedModel?.supported_reasoning_levels ?? [];
    if (reasoningEffort && supported.length > 0 && !supported.includes(reasoningEffort)) {
      return c.json({ error: `reasoning effort '${reasoningEffort}' is not supported by '${model}'; supported: ${supported.join(', ')}` }, 400);
    }

    const workflow = getAppWorkflowView(deps, id);
    const coordinatorId = workflow?.coordinator_session_id ?? session.coordinator_session_id;
    if (!coordinatorId || !deps.sessionStore.getSession(coordinatorId)) {
      return c.json({ error: 'app coordinator session is unavailable' }, 409);
    }
    deps.sessionStore.updateSessionProvider(coordinatorId, provider, model);
    deps.sessionStore.setSessionReasoningEffort(coordinatorId, reasoningEffort);
    deps.appStudioStore.appendWorkflowEvent(id, 'agents.runtime_configured', 'agents', String(coordinatorId), JSON.stringify({ provider, model, reasoning_effort: reasoningEffort }));
    return c.json({ runtime: { provider, model, reasoning_effort: reasoningEffort } });
  });

  app.patch('/api/app-studio/sessions/:id/agents/config', async (c) => {
    const id = parseIdParam(c);
    const session = deps.appStudioStore.getSession(id);
    if (!session) return notFound(c);
    const body = await parseJsonBody<Record<string, unknown>>(c);
    const previous = parseAppAgentConfig(session.agent_config_json);
    const next = parseAppAgentConfig(body);
    const knownSkills = new Set(availableSkills(deps, session.project_id).map((skill) => skill.id));
    const unknownSkills = [...assignedSkills(next)].filter((skillId) => !knownSkills.has(skillId));
    if (unknownSkills.length > 0) {
      return c.json({ error: `unknown skill id(s): ${unknownSkills.join(', ')}` }, 400);
    }
    const workflow = getAppWorkflowView(deps, id);
    const coordinatorId = workflow?.coordinator_session_id ?? session.coordinator_session_id;
    if (coordinatorId) {
      const before = assignedSkills(previous);
      const after = assignedSkills(next);
      for (const skillId of before) if (!after.has(skillId)) deps.skillStore.setSessionSkillEnabled(coordinatorId, skillId, false);
      for (const skillId of after) deps.skillStore.setSessionSkillEnabled(coordinatorId, skillId, true);
    }
    const json = serializeAppAgentConfig(next);
    deps.appStudioStore.setAgentConfigJson(id, json);
    deps.appStudioStore.appendWorkflowEvent(id, 'agents.configured', 'agents', String(id), json);
    return c.json({ config: parseAppAgentConfig(json) });
  });
}
