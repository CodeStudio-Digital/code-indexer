import { getAllKnownToolsMeta, profileToTiers } from '@mcp/code-agent/tools/tiers.js';
import { appStudioToolNamesForRole } from '@mcp/company/tools/app-studio/index.js';
import { isMasterAllowed } from '@mcp/company/tools/master-filter.js';
import type { CompanySessionId } from '@mcp/session-storage';

export type AppTeamTier = 'bootstrap' | 'navigate' | 'full';

export interface AppTeamModelRef {
  provider: string;
  model: string;
}

export interface AppTeamRoleConfig {
  role: string;
  enabled: boolean;
  provider: string;
  model: string;
  tier: AppTeamTier;
  projectIds?: number[];
  skills?: string[];
  initialTools?: string[];
  /** Read-only catalog of built-in tools that this App runtime can actually register for the role. */
  availableToolNames?: string[];
  systemPromptOverride?: string;
  temperature?: number;
  reasoningEffort?: string;
  thinking?: boolean;
  thinkingBudgetTokens?: number;
  fallbackModels: AppTeamModelRef[];
}

interface AppTeamConfigView {
  company_session_id: CompanySessionId | null;
  status: 'idle' | 'running' | 'paused' | 'completed' | 'error';
  operational_rules: string;
  roles: AppTeamRoleConfig[];
}

export interface AppTeamConfigPatch {
  operational_rules?: string;
  roles?: AppTeamRoleConfig[];
}

interface AllowedModel extends AppTeamModelRef {
  label?: string;
  notes?: string;
  is_default?: boolean;
}

function objectConfig(configJson: string | null): Record<string, unknown> {
  let parsed: unknown;
  try { parsed = JSON.parse(configJson || '{}'); } catch { throw new Error('App team config_json is invalid'); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('App team config_json must be an object');
  }
  return parsed as Record<string, unknown>;
}

function cleanString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function optionalStrings(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const result = [...new Set(value.flatMap((entry) => cleanString(entry) ? [cleanString(entry)!] : []))];
  return result.length > 0 ? result : undefined;
}

function optionalProjectIds(value: unknown): number[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const result = [...new Set(value.filter((entry): entry is number => Number.isInteger(entry) && entry > 0))];
  return result.length > 0 ? result : undefined;
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function fallbackModels(value: unknown): AppTeamModelRef[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  return value.flatMap((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return [];
    const provider = cleanString((entry as Record<string, unknown>).provider);
    const model = cleanString((entry as Record<string, unknown>).model);
    if (!provider || !model) return [];
    const key = `${provider}\u0000${model}`;
    if (seen.has(key)) return [];
    seen.add(key);
    return [{ provider, model }];
  });
}

function readStoredRole(value: unknown): AppTeamRoleConfig | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const role = value as Record<string, unknown>;
  const name = cleanString(role.role);
  const provider = cleanString(role.provider);
  const model = cleanString(role.model);
  if (!name || !provider || !model) return null;
  const tier = role.tier === 'bootstrap' || role.tier === 'full' ? role.tier : 'navigate';
  return {
    role: name,
    enabled: role.enabled !== false,
    provider,
    model,
    tier,
    projectIds: optionalProjectIds(role.projectIds),
    skills: optionalStrings(role.skills),
    initialTools: optionalStrings(role.initialTools),
    systemPromptOverride: cleanString(role.systemPromptOverride),
    temperature: optionalNumber(role.temperature),
    reasoningEffort: cleanString(role.reasoningEffort),
    thinking: role.thinking === true ? true : undefined,
    thinkingBudgetTokens: optionalNumber(role.thinkingBudgetTokens),
    fallbackModels: fallbackModels(role.fallbackModels),
  };
}

function masterRole(config: Record<string, unknown>): AppTeamRoleConfig {
  const provider = cleanString(config.master_provider);
  const model = cleanString(config.master_model);
  if (!provider || !model) throw new Error('App team Master has no explicit provider/model');
  const fallbackProvider = cleanString(config.master_fallback_provider);
  const fallbackModel = cleanString(config.master_fallback_model);
  return {
    role: 'master',
    enabled: config.master_enabled !== false,
    provider,
    model,
    tier: 'navigate',
    skills: optionalStrings(config.master_skills),
    initialTools: optionalStrings(config.master_initial_tools),
    systemPromptOverride: cleanString(config.master_system_prompt_override),
    temperature: optionalNumber(config.master_temperature),
    reasoningEffort: cleanString(config.master_reasoning_effort),
    thinking: config.master_thinking === true ? true : undefined,
    thinkingBudgetTokens: optionalNumber(config.master_thinking_budget_tokens),
    fallbackModels: fallbackProvider && fallbackModel ? [{ provider: fallbackProvider, model: fallbackModel }] : [],
  };
}

function withAvailableToolCatalog(role: AppTeamRoleConfig): AppTeamRoleConfig {
  const isMaster = role.role === 'master';
  const activeTiers = profileToTiers(isMaster ? 'navigate' : role.tier);
  activeTiers.add('company');
  activeTiers.add('app');
  if (isMaster) activeTiers.add('master');
  if (role.role === 'database') activeTiers.add('db');
  if (['frontend', 'ux', 'qa', 'fullstack'].includes(role.role)) activeTiers.add('preview');

  const allowedAppTools = appStudioToolNamesForRole(
    isMaster ? 'company-master' : 'company-subordinate',
    role.role,
  );
  const tools = getAllKnownToolsMeta().filter((tool) => {
    if (!activeTiers.has(tool.tier)) return false;
    if (tool.tier === 'app' && !allowedAppTools.has(tool.name)) return false;
    if (!isMaster && tool.tier === 'company' && tool.name.startsWith('kanban_')) return false;
    if (!isMaster) return true;
    return isMasterAllowed(
      { name: tool.name, source: tool.source } as Parameters<typeof isMasterAllowed>[0],
      { allowAppStudio: true },
    );
  });

  return { ...role, availableToolNames: [...new Set(tools.map((tool) => tool.name))] };
}

export function readAppTeamConfig(
  configJson: string | null,
  companySessionId: CompanySessionId | null,
  status: AppTeamConfigView['status'],
): AppTeamConfigView {
  const config = objectConfig(configJson);
  if (config.runtime_kind !== 'app_studio') throw new Error('Company team is not owned by App Studio');
  const roles = Array.isArray(config.role_assignments)
    ? config.role_assignments.flatMap((role) => {
        const parsed = readStoredRole(role);
        return parsed ? [parsed] : [];
      })
    : [];
  return {
    company_session_id: companySessionId,
    status,
    operational_rules: typeof config.operational_rules === 'string' ? config.operational_rules : '',
    roles: [masterRole(config), ...roles].map(withAvailableToolCatalog),
  };
}

function normalizedRole(input: AppTeamRoleConfig, index: number): AppTeamRoleConfig {
  if (!input || typeof input !== 'object') throw new Error(`roles[${index}] must be an object`);
  const role = cleanString(input.role)?.toLowerCase();
  const provider = cleanString(input.provider);
  const model = cleanString(input.model);
  if (!role || !provider || !model) throw new Error(`roles[${index}] needs role, provider and model`);
  if (!/^[a-z0-9_-]{1,80}$/.test(role)) throw new Error(`roles[${index}].role is invalid`);
  if (!['bootstrap', 'navigate', 'full'].includes(input.tier)) throw new Error(`roles[${index}].tier is invalid`);
  if (input.temperature !== undefined && (!Number.isFinite(input.temperature) || input.temperature < 0 || input.temperature > 1)) {
    throw new Error(`roles[${index}].temperature must be between 0 and 1`);
  }
  if (input.thinkingBudgetTokens !== undefined && (!Number.isInteger(input.thinkingBudgetTokens) || input.thinkingBudgetTokens <= 0)) {
    throw new Error(`roles[${index}].thinkingBudgetTokens must be a positive integer`);
  }
  const fallbacks = fallbackModels(input.fallbackModels);
  if (role === 'master' && fallbacks.length > 1) throw new Error('The Master accepts one explicit fallback');
  if (fallbacks.some((fallback) => fallback.provider === provider && fallback.model === model)) {
    throw new Error(`role '${role}' fallback must differ from its primary model`);
  }
  return {
    role,
    enabled: input.enabled !== false,
    provider,
    model,
    tier: role === 'master' ? 'navigate' : input.tier,
    projectIds: optionalProjectIds(input.projectIds),
    skills: optionalStrings(input.skills),
    initialTools: optionalStrings(input.initialTools),
    systemPromptOverride: cleanString(input.systemPromptOverride)?.slice(0, 12_000),
    temperature: input.temperature,
    reasoningEffort: cleanString(input.reasoningEffort),
    thinking: input.thinking === true ? true : undefined,
    thinkingBudgetTokens: input.thinking === true ? input.thinkingBudgetTokens : undefined,
    fallbackModels: fallbacks,
  };
}

function setOptional(config: Record<string, unknown>, key: string, value: unknown): void {
  if (value === undefined || value === null || value === '') delete config[key];
  else config[key] = value;
}

function derivedAllowedModels(roles: AppTeamRoleConfig[], previous: unknown): AllowedModel[] {
  const metadata = new Map<string, AllowedModel>();
  if (Array.isArray(previous)) {
    for (const entry of previous) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
      const model = entry as Record<string, unknown>;
      const provider = cleanString(model.provider);
      const name = cleanString(model.model);
      if (provider && name) metadata.set(`${provider}\u0000${name}`, model as unknown as AllowedModel);
    }
  }
  const master = roles.find((role) => role.role === 'master')!;
  const ordered = roles.flatMap((role) => [{ provider: role.provider, model: role.model }, ...role.fallbackModels]);
  const seen = new Set<string>();
  return ordered.flatMap((model) => {
    const key = `${model.provider}\u0000${model.model}`;
    if (seen.has(key)) return [];
    seen.add(key);
    const old = metadata.get(key);
    const isDefault = model.provider === master.provider && model.model === master.model;
    return [{
      provider: model.provider,
      model: model.model,
      ...(old?.label ? { label: old.label } : { label: isDefault ? 'App default' : 'App role runtime' }),
      ...(old?.notes ? { notes: old.notes } : {}),
      is_default: isDefault,
    }];
  });
}

export function applyAppTeamConfigPatch(
  configJson: string | null,
  patch: AppTeamConfigPatch,
): { configJson: string; roles: AppTeamRoleConfig[]; allowedModels: AllowedModel[]; changedKeys: string[] } {
  const config = objectConfig(configJson);
  if (config.runtime_kind !== 'app_studio') throw new Error('Company team is not owned by App Studio');
  const changedKeys: string[] = [];

  if (patch.operational_rules !== undefined) {
    if (typeof patch.operational_rules !== 'string') throw new Error('operational_rules must be a string');
    setOptional(config, 'operational_rules', patch.operational_rules.trim());
    changedKeys.push('operational_rules');
  }

  const current = readAppTeamConfig(configJson, null, 'idle').roles;
  if (patch.roles !== undefined && !Array.isArray(patch.roles)) throw new Error('roles must be an array');
  const roles = patch.roles === undefined ? current : patch.roles.map(normalizedRole);
  if (patch.roles !== undefined) {
    if (roles.length < 2 || roles.length > 33) throw new Error('roles must contain the Master and between 1 and 32 specialists');
    const names = roles.map((role) => role.role);
    if (new Set(names).size !== names.length) throw new Error('role names must be unique');
    if (names.filter((role) => role === 'master').length !== 1) throw new Error('roles must contain exactly one Master');
    const master = roles.find((role) => role.role === 'master')!;
    config.master_enabled = master.enabled;
    config.master_provider = master.provider;
    config.master_model = master.model;
    config.master_tier = 'navigate';
    setOptional(config, 'master_skills', master.skills);
    setOptional(config, 'master_initial_tools', master.initialTools);
    setOptional(config, 'master_system_prompt_override', master.systemPromptOverride);
    setOptional(config, 'master_temperature', master.temperature);
    setOptional(config, 'master_reasoning_effort', master.reasoningEffort);
    setOptional(config, 'master_thinking', master.thinking);
    setOptional(config, 'master_thinking_budget_tokens', master.thinkingBudgetTokens);
    setOptional(config, 'master_fallback_provider', master.fallbackModels[0]?.provider);
    setOptional(config, 'master_fallback_model', master.fallbackModels[0]?.model);
    config.role_assignments = roles.filter((role) => role.role !== 'master');
    config.allowed_models = derivedAllowedModels(roles, config.allowed_models);
    changedKeys.push('roles');
  }

  return {
    configJson: JSON.stringify(config),
    roles,
    allowedModels: Array.isArray(config.allowed_models) ? config.allowed_models as AllowedModel[] : [],
    changedKeys,
  };
}
