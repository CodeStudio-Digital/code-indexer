import { nativeReasoningLevels } from '@mcp/provider-sdk';
import { withDefaultQaSkill, declaredRoleSkillIds } from '@mcp/company-contracts/qa-defaults.js';
import type { CompanyRoleConfig } from '@mcp/company/types.js';
import { blankPlan, newRole, type DesignPlan } from '@mcp/company-contracts/designer.js';
import { validatePlanGraph } from '@mcp/company/tools/kanban-plan-graph-core.js';
import type { ServerDeps } from '../../deps.js';
import { validateAllowedModels } from './session-create-validation.js';

export function checkModel(deps: ServerDeps, provider: string, model: string, effort = '') {
  const row = deps.providerStore.getProvider(provider);
  const match =
    row?.enabled &&
    row.use_for_coder &&
    deps.providerStore
      .listModels(provider, true)
      .find((m) => (m.mode ? m.model_id + '::' + m.mode : m.model_id) === model);
  if (!match) throw new Error('Modelo indisponível no provedor solicitado: ' + provider + ' / ' + model);
  if (
    effort &&
    (!match.can_reason || !nativeReasoningLevels(match.supported_reasoning_levels).includes(effort))
  ) {
    throw new Error('Esforço indisponível em ' + provider + ' / ' + model + ': ' + effort);
  }
}
export function validateDesign(deps: ServerDeps, plan: DesignPlan) {
  if (!plan.name || !plan.projectIds.length)
    throw new Error('Informe o nome e selecione pelo menos um projeto.');
  if (plan.roles.filter((r) => r.role === 'master').length !== 1)
    throw new Error('Defina um único coordenador (master).');
  if (new Set(plan.roles.map((r) => r.role)).size !== plan.roles.length)
    throw new Error('Há papéis com o mesmo nome.');
  for (const id of plan.projectIds)
    if (!deps.db.getProject(id)) throw new Error('Projeto indisponível: ' + id);
  for (const role of plan.roles) {
    checkModel(deps, role.provider, role.model, role.effort);
    if (role.role === 'master' && role.readOnly)
      throw new Error('Somente leitura é aplicado aos subordinados. O coordenador organiza a equipe.');
    if (role.projectIds.some((id) => !plan.projectIds.includes(id)))
      throw new Error('Projeto fora do escopo de ' + role.role);
    if (role.skills.length) {
      const scopes = ['global', ...(role.projectIds.length ? role.projectIds : plan.projectIds).map(String)];
      const found = deps.skillStore.listSkillSummaries({
        scopes,
        enabled: true,
        ids: role.skills,
        offset: 0,
        limit: 64,
      });
      const missing = role.skills.find((id) => !found.items.some((s) => s.id === id));
      if (missing) throw new Error('Skill indisponível para ' + role.role + ': ' + missing);
    }
  }
  if (plan.tasks.length) {
    const graph = validatePlanGraph(plan.tasks.map((t) => ({ ...t, depends_on: t.dependsOn })));
    if (!graph.ok) throw new Error(graph.error);
  }
  for (const task of plan.tasks) {
    const owner = plan.roles.find((r) => r.role === task.owner && r.role !== 'master');
    if (task.owner && !owner) throw new Error('Responsável inválido em ' + task.title);
    if (
      task.projectId !== null &&
      (!plan.projectIds.includes(task.projectId) ||
        (owner?.projectIds.length && !owner.projectIds.includes(task.projectId)))
    ) {
      throw new Error('Projeto incompatível com o responsável em ' + task.title);
    }
  }
}

export function fromCompany(name: string, projectIds: number[], config: Record<string, any>): DesignPlan {
  const roles = (config.role_assignments ?? []) as CompanyRoleConfig[];
  const master: CompanyRoleConfig = roles.find((r) => r.role === 'master') ?? {
    role: 'master',
    provider: config.master_provider ?? '',
    model: config.master_model ?? '',
    tier: 'navigate',
  };
  return {
    ...blankPlan(),
    name,
    projectIds,
    goal: config.design_goal ?? '',
    rules: config.operational_rules ?? '',
    concurrency: config.design_concurrency ?? null,
    visualQA: config.visual_qa === true,
    roles: [
      {
        ...master,
        reasoningEffort: config.master_reasoning_effort ?? master.reasoningEffort,
        systemPromptOverride: config.master_system_prompt_override ?? master.systemPromptOverride,
        skills: config.master_skills ?? master.skills,
      },
      ...roles.filter((r) => r.role !== 'master'),
    ].map((r) => ({
      ...newRole(r.role, r.provider, r.model),
      responsibility: r.systemPromptOverride ?? '',
      effort: r.reasoningEffort ?? '',
      skills: declaredRoleSkillIds(r.skills),
      projectIds: r.projectIds ?? [],
      readOnly: r.readOnly === true,
    })),
  };
}
export function companyDesignConfig(plan: DesignPlan, previous: Record<string, any> = {}) {
  const oldRoles: CompanyRoleConfig[] = previous.role_assignments ?? [];
  const roles = plan.roles.map((r) => {
    const old = oldRoles.find((o) => o.role === r.role);
    const keepSkills = old && JSON.stringify(declaredRoleSkillIds(old.skills)) === JSON.stringify(r.skills);
    return {
      ...old,
      role: r.role,
      provider: r.provider,
      model: r.model,
      tier: old?.tier ?? 'navigate',
      projectIds: r.projectIds,
      systemPromptOverride: r.responsibility || undefined,
      reasoningEffort: r.effort || undefined,
      skills: keepSkills ? old.skills : r.skills,
      readOnly: r.readOnly,
    } satisfies CompanyRoleConfig;
  });
  const master = roles.find((r) => r.role === 'master')!;
  if (previous.allowed_models?.length) {
    const reason = validateAllowedModels(previous.allowed_models, {
      name: plan.name,
      project_ids: plan.projectIds,
      master_provider: master.provider,
      master_model: master.model,
      role_assignments: roles,
    });
    if (reason) throw new Error(reason);
  }
  return {
    ...previous,
    master_provider: master.provider,
    master_model: master.model,
    master_reasoning_effort: master.reasoningEffort ?? undefined,
    master_system_prompt_override: master.systemPromptOverride ?? undefined,
    master_skills: declaredRoleSkillIds(master.skills),
    role_assignments: plan.visualQA ? roles.map(withDefaultQaSkill) : roles,
    operational_rules: plan.rules,
    design_goal: plan.goal,
    design_concurrency: plan.concurrency,
    visual_qa: plan.visualQA,
  };
}
