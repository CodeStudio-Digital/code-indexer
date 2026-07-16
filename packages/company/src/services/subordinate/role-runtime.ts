import type {
  AllowedModel,
  CompanyAgentDispatchSource,
  CompanyRuntimeKind,
  RoleSkills,
} from '@mcp/company/types.js';

export type RoleDispatchSource = CompanyAgentDispatchSource;
export type { CompanyRuntimeKind };

export type RoleToolTier = 'bootstrap' | 'navigate' | 'full';

/**
 * Structural view of a persisted role assignment. Kept local to the runtime
 * so the spawn path can consume old rows while the public contract evolves.
 */
export interface PersistedRoleRuntime {
  role: string;
  enabled?: boolean;
  provider?: string;
  model?: string;
  tier?: string;
  skills?: RoleSkills;
  systemPromptOverride?: string;
  projectIds?: number[];
  temperature?: number;
  thinking?: boolean;
  thinkingBudgetTokens?: number;
  reasoningEffort?: string;
  fallbackModels?: AllowedModel[];
}

export interface RoleRuntimeRequest {
  provider?: string;
  model?: string;
  tier?: RoleToolTier;
  skills?: RoleSkills;
  roleOverride?: string;
  temperature?: number;
  thinking?: boolean;
  thinkingBudgetTokens?: number;
  reasoningEffort?: string;
}

export interface RoleRuntimePolicy {
  runtimeKind: CompanyRuntimeKind;
  roleConfig: PersistedRoleRuntime | null;
  allowedModels: AllowedModel[];
  poolDefault: AllowedModel | null;
}

export type RoleRuntimeResolutionSource =
  | 'role_assignment'
  | 'spawn_request'
  | 'allowed_models_default'
  | 'master_runtime'
  | 'legacy_default';

export interface EffectiveRoleRuntime {
  provider: string;
  model: string;
  tier: RoleToolTier;
  skills?: RoleSkills;
  roleOverride?: string;
  temperature?: number;
  thinking?: boolean;
  thinkingBudgetTokens?: number;
  reasoningEffort?: string;
  configuredProvider: string | null;
  configuredModel: string | null;
  dispatchSource: RoleDispatchSource;
  resolutionSource: RoleRuntimeResolutionSource;
  fallbackModels: AllowedModel[];
}

export interface ResolveEffectiveRoleRuntimeInput {
  role: string;
  runtimeKind: CompanyRuntimeKind;
  roleConfig: PersistedRoleRuntime | null;
  requested: RoleRuntimeRequest;
  allowedModels: readonly AllowedModel[];
  poolDefault: AllowedModel | null;
  masterRuntime: AllowedModel | null;
  dispatchSource?: RoleDispatchSource;
}

export interface ResolveEffectiveMasterRuntimeInput {
  configJson: string | null | undefined;
  runtimeKind?: CompanyRuntimeKind;
  requested?: RoleRuntimeRequest;
  dispatchSource?: RoleDispatchSource;
}

const LEGACY_DEFAULT: AllowedModel = {
  provider: 'anthropic',
  model: 'claude-sonnet-4-6',
};

function clean(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function isModel(value: unknown): value is AllowedModel {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<AllowedModel>;
  return !!clean(candidate.provider) && !!clean(candidate.model);
}

function normalizeModel(value: AllowedModel): AllowedModel {
  return {
    ...value,
    provider: value.provider.trim(),
    model: value.model.trim(),
  };
}

function isTier(value: unknown): value is RoleToolTier {
  return value === 'bootstrap' || value === 'navigate' || value === 'full';
}

function modelKey(model: Pick<AllowedModel, 'provider' | 'model'>): string {
  return `${model.provider}\u0000${model.model}`;
}

function uniqueModels(models: readonly AllowedModel[]): AllowedModel[] {
  const seen = new Set<string>();
  const result: AllowedModel[] = [];
  for (const raw of models) {
    if (!isModel(raw)) continue;
    const model = normalizeModel(raw);
    const key = modelKey(model);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(model);
  }
  return result;
}

/**
 * Read the spawn policy directly from the persisted session config. This is
 * intentionally done for every fresh spawn: scheduler/pipeline calls must see
 * the same role_assignments update as a Master-initiated call, even if an
 * in-memory roster is stale for a beat.
 */
export function readRoleRuntimePolicy(
  configJson: string | null | undefined,
  role: string,
  runtimeKind: CompanyRuntimeKind = 'company',
): RoleRuntimePolicy {
  if (!configJson) {
    return { runtimeKind, roleConfig: null, allowedModels: [], poolDefault: null };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(configJson);
  } catch {
    throw new Error('Company session config_json is invalid; refusing to resolve a subordinate runtime');
  }
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('Company session config_json must be an object');
  }

  const cfg = parsed as {
    runtime_kind?: unknown;
    role_assignments?: unknown;
    allowed_models?: unknown;
  };
  const persistedKind = cfg.runtime_kind === 'app_studio' ? 'app_studio' : runtimeKind;
  const roleAssignments = Array.isArray(cfg.role_assignments)
    ? cfg.role_assignments.filter(
      (entry): entry is PersistedRoleRuntime =>
        !!entry && typeof entry === 'object' && clean((entry as PersistedRoleRuntime).role) === role,
    )
    : [];
  // A malformed duplicate should not make selection dependent on array order
  // established months ago. The most recently written entry (last) wins.
  const roleConfig = roleAssignments.at(-1) ?? null;
  const allowedModels = uniqueModels(
    Array.isArray(cfg.allowed_models) ? cfg.allowed_models.filter(isModel) : [],
  );
  const poolDefault =
    allowedModels.find((entry) => entry.is_default) ?? allowedModels[0] ?? null;

  return { runtimeKind: persistedKind, roleConfig, allowedModels, poolDefault };
}

/**
 * Resolve one immutable runtime snapshot for a fresh agent run.
 *
 * Configured roles are authoritative: provider/model/tier/reasoning and
 * related role settings come from role_assignments and spawn-supplied model
 * overrides are ignored. App Studio additionally rejects unconfigured roles,
 * preventing a global subagent/pool default from silently selecting a mini
 * model. Generic Company sessions retain the legacy unconfigured-role path.
 */
export function resolveEffectiveRoleRuntime(
  input: ResolveEffectiveRoleRuntimeInput,
): EffectiveRoleRuntime {
  const configured = input.roleConfig;
  const dispatchSource = input.dispatchSource ?? 'company';
  let selected: AllowedModel;
  let source: RoleRuntimeResolutionSource;
  let tier: RoleToolTier;

  if (configured) {
    if (configured.enabled === false) {
      throw new Error(`Role '${input.role}' is disabled in role_assignments`);
    }
    const provider = clean(configured.provider);
    const model = clean(configured.model);
    if (!provider || !model) {
      throw new Error(
        `Role '${input.role}' has an incomplete configured runtime; provider and model are required`,
      );
    }
    if (!isTier(configured.tier)) {
      throw new Error(
        `Role '${input.role}' has invalid tier '${String(configured.tier)}'; expected bootstrap, navigate, or full`,
      );
    }
    selected = { provider, model };
    source = 'role_assignment';
    tier = configured.tier;
  } else {
    if (input.runtimeKind === 'app_studio') {
      throw new Error(
        `Role '${input.role}' is not configured for this App Studio team; add and enable the role before dispatching`,
      );
    }
    const requestedProvider = clean(input.requested.provider);
    const requestedModel = clean(input.requested.model);
    if (!!requestedProvider !== !!requestedModel) {
      throw new Error(
        `Unconfigured role '${input.role}' must specify provider and model together`,
      );
    }
    if (requestedProvider && requestedModel) {
      selected = { provider: requestedProvider, model: requestedModel };
      source = 'spawn_request';
    } else if (input.poolDefault) {
      selected = normalizeModel(input.poolDefault);
      source = 'allowed_models_default';
    } else if (input.masterRuntime) {
      selected = normalizeModel(input.masterRuntime);
      source = 'master_runtime';
    } else {
      selected = LEGACY_DEFAULT;
      source = 'legacy_default';
    }
    tier = input.requested.tier ?? 'navigate';
  }

  const allowedModels = uniqueModels(input.allowedModels);
  if (
    allowedModels.length > 0 &&
    !allowedModels.some((candidate) => modelKey(candidate) === modelKey(selected))
  ) {
    const options = allowedModels
      .map((entry) => `${entry.provider}/${entry.model}${entry.is_default ? ' (default)' : ''}`)
      .join(', ');
    throw new Error(
      `Model '${selected.provider}/${selected.model}' for role '${input.role}' is not in this session's allowed_models pool. ` +
        `Configured options: ${options}.`,
    );
  }

  const explicitFallbacks = configured
    ? uniqueModels(configured.fallbackModels ?? [])
    : allowedModels;
  const fallbackModels = explicitFallbacks.filter(
    (candidate) => modelKey(candidate) !== modelKey(selected),
  );

  return {
    provider: selected.provider,
    model: selected.model,
    tier,
    skills: configured?.skills ?? input.requested.skills,
    roleOverride: configured?.systemPromptOverride ?? input.requested.roleOverride,
    temperature: configured?.temperature ?? input.requested.temperature,
    // Persisted role settings are one immutable runtime snapshot. App/Company
    // callers cannot silently weaken or strengthen a configured role per run.
    thinking: configured ? configured.thinking : input.requested.thinking,
    thinkingBudgetTokens:
      configured?.thinkingBudgetTokens ?? input.requested.thinkingBudgetTokens,
    reasoningEffort: configured?.reasoningEffort ?? input.requested.reasoningEffort,
    configuredProvider: configured ? selected.provider : null,
    configuredModel: configured ? selected.model : null,
    dispatchSource,
    resolutionSource: source,
    fallbackModels,
  };
}

/**
 * Resolve the Master through the same authoritative runtime contract used by
 * every specialist dispatch. `master_provider/master_model` are represented
 * as the configured `app_orchestrator` role at the boundary, so an App can
 * never fall through to a pool/global/legacy model when its persisted Master
 * tuple is missing. Generic Company sessions retain their explicit pool and
 * legacy compatibility chain.
 */
export function resolveEffectiveMasterRuntime(
  input: ResolveEffectiveMasterRuntimeInput,
): EffectiveRoleRuntime {
  let parsed: Record<string, unknown> = {};
  if (input.configJson) {
    try {
      const raw = JSON.parse(input.configJson) as unknown;
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        throw new Error('Company session config_json must be an object');
      }
      parsed = raw as Record<string, unknown>;
    } catch (error) {
      if (error instanceof Error && error.message === 'Company session config_json must be an object') {
        throw error;
      }
      throw new Error('Company session config_json is invalid; refusing to resolve the Master runtime');
    }
  }

  const runtimeKind: CompanyRuntimeKind = parsed.runtime_kind === 'app_studio'
    ? 'app_studio'
    : input.runtimeKind ?? 'company';
  const provider = clean(parsed.master_provider);
  const model = clean(parsed.master_model);
  if (!!provider !== !!model) {
    throw new Error('Master runtime must configure master_provider and master_model together');
  }
  const fallbackProvider = clean(parsed.master_fallback_provider);
  const fallbackModel = clean(parsed.master_fallback_model);
  if (!!fallbackProvider !== !!fallbackModel) {
    throw new Error(
      'Master fallback must configure master_fallback_provider and master_fallback_model together',
    );
  }
  const masterEnabled = parsed.master_enabled;
  if (masterEnabled !== undefined && typeof masterEnabled !== 'boolean') {
    throw new Error('master_enabled must be a boolean when configured');
  }
  const masterTier = parsed.master_tier;
  if (masterTier !== undefined && !isTier(masterTier)) {
    throw new Error('master_tier must be bootstrap, navigate, or full when configured');
  }
  const masterTemperature = parsed.master_temperature;
  if (
    masterTemperature !== undefined
    && (typeof masterTemperature !== 'number' || !Number.isFinite(masterTemperature))
  ) {
    throw new Error('master_temperature must be a finite number when configured');
  }
  const masterThinking = parsed.master_thinking;
  if (masterThinking !== undefined && typeof masterThinking !== 'boolean') {
    throw new Error('master_thinking must be a boolean when configured');
  }
  const masterThinkingBudget = parsed.master_thinking_budget_tokens;
  if (
    masterThinkingBudget !== undefined
    && (
      typeof masterThinkingBudget !== 'number'
      || !Number.isInteger(masterThinkingBudget)
      || masterThinkingBudget <= 0
    )
  ) {
    throw new Error('master_thinking_budget_tokens must be a positive integer when configured');
  }
  const rawMasterSkills = parsed.master_skills;
  if (
    rawMasterSkills !== undefined
    && (!Array.isArray(rawMasterSkills) || rawMasterSkills.some((skill) => !clean(skill)))
  ) {
    throw new Error('master_skills must be an array of non-empty skill ids when configured');
  }
  const masterSkills = Array.isArray(rawMasterSkills)
    ? [...new Set(rawMasterSkills.map((skill) => (skill as string).trim()))]
    : undefined;
  const rawMasterPrompt = parsed.master_system_prompt_override;
  if (rawMasterPrompt !== undefined && typeof rawMasterPrompt !== 'string') {
    throw new Error('master_system_prompt_override must be a string when configured');
  }
  const masterSystemPromptOverride = clean(rawMasterPrompt)?.slice(0, 12_000);
  const allowedModels = uniqueModels(
    Array.isArray(parsed.allowed_models)
      ? parsed.allowed_models.filter(isModel)
      : [],
  );
  const poolDefault = allowedModels.find((entry) => entry.is_default)
    ?? allowedModels[0]
    ?? null;
  const configuredRole: PersistedRoleRuntime | null = provider && model
    ? {
        role: 'app_orchestrator',
        enabled: masterEnabled as boolean | undefined,
        provider,
        model,
        // Validate the persisted tier above, but keep the Master at navigate:
        // its orchestration allowlist is a separate capability boundary and a
        // config edit must never expand it into a code-editing agent.
        tier: 'navigate',
        temperature: masterTemperature as number | undefined,
        thinking: masterThinking as boolean | undefined,
        thinkingBudgetTokens: masterThinkingBudget as number | undefined,
        reasoningEffort: clean(parsed.master_reasoning_effort),
        skills: masterSkills,
        systemPromptOverride: masterSystemPromptOverride,
        fallbackModels: fallbackProvider && fallbackModel
          ? [{ provider: fallbackProvider, model: fallbackModel }]
          : [],
      }
    : null;

  return resolveEffectiveRoleRuntime({
    role: 'app_orchestrator',
    runtimeKind,
    roleConfig: configuredRole,
    requested: {
      ...input.requested,
      tier: 'navigate',
    },
    allowedModels,
    poolDefault,
    masterRuntime: runtimeKind === 'company' ? LEGACY_DEFAULT : null,
    dispatchSource: input.dispatchSource ?? (runtimeKind === 'app_studio' ? 'app_studio' : 'company'),
  });
}

export interface ResolveRoleFallbackInput {
  current: AllowedModel;
  runtimeKind: CompanyRuntimeKind;
  roleConfig: PersistedRoleRuntime | null;
  allowedModels: readonly AllowedModel[];
}

export interface ResolvedRoleFallback {
  provider: string;
  model: string;
  reason: 'role_fallback_models' | 'allowed_models_fallback';
}

/** Pick the next explicitly permitted runtime for a transient retry. */
export function resolveRoleFallback(
  input: ResolveRoleFallbackInput,
): ResolvedRoleFallback | null {
  const currentKey = modelKey(input.current);
  const allowed = uniqueModels(input.allowedModels);
  const allowedKeys = new Set(allowed.map(modelKey));

  if (input.roleConfig) {
    const configured = uniqueModels(input.roleConfig.fallbackModels ?? []);
    const currentIndex = configured.findIndex(
      (candidate) => modelKey(candidate) === currentKey,
    );
    const remaining = currentIndex >= 0
      ? configured.slice(currentIndex + 1)
      : configured;
    const next = remaining.find(
      (candidate) =>
        (allowedKeys.size === 0 || allowedKeys.has(modelKey(candidate))),
    );
    return next
      ? { provider: next.provider, model: next.model, reason: 'role_fallback_models' }
      : null;
  }

  // App teams require every role to exist, but keep this guard explicit so a
  // corrupt/migrating row can never fall through to the global model pool.
  if (input.runtimeKind === 'app_studio') return null;
  const next = [
    ...allowed.filter((candidate) => candidate.is_default),
    ...allowed.filter((candidate) => !candidate.is_default),
  ].find((candidate) => modelKey(candidate) !== currentKey);
  return next
    ? { provider: next.provider, model: next.model, reason: 'allowed_models_fallback' }
    : null;
}
