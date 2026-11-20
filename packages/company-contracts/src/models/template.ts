/**
 * Conditional / chain shape for `CompanyRoleConfig.skills`. Lets a role
 * declare stack-specific skill picks (`{ when: "session.stack === 'react-ts'", skill: 'ds-components-react' }`)
 * plus auxiliary skills that always come along (`chain`).
 *
 * Resolved at spawn-time via `resolveRoleSkills`. The result is a flat
 * `string[]` of skill IDs that get session-level overrides applied.
 */
export interface RoleSkillsConfig {
  /** Used when no `conditional` branch matches. */
  primary?: string;
  /** Skills always appended after the primary/conditional pick (e.g. shared QA). */
  chain?: string[];
  /**
   * Branches evaluated in order; first matching branch contributes its
   * `skill` as the primary. The `when` expression supports a tiny subset of
   * syntax for safety: `session.<key> === '<literal>'` only.
   */
  conditional?: Array<{ when: string; skill: string }>;
}

export type RoleSkills = string[] | RoleSkillsConfig;

export interface RoleFallbackModel {
  provider: string;
  model: string;
}

export interface ResolveRoleSkillsContext {
  /** Builder sandbox stack — set by `getSandboxStackForService` at spawn. */
  stack?: string;
}

/**
 * Flatten a `RoleSkills` value (either legacy `string[]` or the v2
 * `RoleSkillsConfig` object) into the final list of skill IDs to enable
 * for the spawning subordinate.
 */
export function resolveRoleSkills(
  skills: RoleSkills | undefined,
  ctx: ResolveRoleSkillsContext,
): string[] {
  if (!skills) return [];
  if (Array.isArray(skills)) return skills;

  const out: string[] = [];

  if (skills.conditional && skills.conditional.length > 0) {
    for (const branch of skills.conditional) {
      if (evalSkillCondition(branch.when, ctx)) {
        if (!out.includes(branch.skill)) out.push(branch.skill);
        break;
      }
    }
  }

  if (out.length === 0 && skills.primary) {
    out.push(skills.primary);
  }

  if (skills.chain && skills.chain.length > 0) {
    for (const s of skills.chain) {
      if (!out.includes(s)) out.push(s);
    }
  }

  return out;
}

/**
 * Evaluate a `when` expression. Whitelisted forms only — anything else
 * returns false. Keeping this tiny prevents arbitrary code execution from
 * a stored template definition.
 *
 * Supported:
 *   - `session.<key> === '<literal>'`
 *   - `session.<key> == '<literal>'`
 */
function evalSkillCondition(expr: string, ctx: ResolveRoleSkillsContext): boolean {
  const m = /^session\.([a-zA-Z_]\w*)\s*===?\s*['"]([^'"]+)['"]$/.exec(expr.trim());
  if (!m) return false;
  const [, key, value] = m;
  switch (key) {
    case 'stack':
      return ctx.stack === value;
    default:
      return false;
  }
}

export interface CompanyRoleConfig {
  role: string;
  provider: string;
  model: string;
  tier: 'bootstrap' | 'navigate' | 'full';
  /** Disabled roles remain visible/editable but cannot receive new work. */
  enabled?: boolean;
  systemPromptOverride?: string;
  /** Symbolic labels resolved to real project_ids at session creation. */
  projectHints?: string[];
  /**
   * Skills to enable for this role. Either a flat list (legacy) or a
   * conditional/chain config (v2) — see `RoleSkillsConfig`. Resolved via
   * `resolveRoleSkills` at spawn-time, then persisted as a session-bundle
   * skill projection.
   */
  skills?: RoleSkills;
  /** Tool names pinned into the role's visible catalog from turn one.
   * This is a starting preset, not an allowlist: find_tools and direct calls
   * remain available for capabilities outside this list. */
  initialTools?: string[];
  /**
   * Concrete project ids this role is bound to in THIS session. When set,
   * `spawn_subordinate_agent` auto-resolves `project_id` (single binding) or
   * enforces that the master-supplied id is one of them (multi-binding).
   * Empty/undefined = unbound (legacy free-form behaviour).
   *
   * Session-level only; never persisted in `company_templates.roles_json`
   * because project ids don't exist until a session is created.
   */
  projectIds?: number[];
  /**
   * Sampling temperature override for this role. When set, takes precedence
   * over the agent preset's `defaultTemperature` but is itself overridden by
   * a per-session value. Range [0, 1]; resolver clamps. Persisted in
   * `company_templates.roles_json` (no schema change — JSON field).
   */
  temperature?: number;
  /**
   * Per-role sticky reasoning-effort override (e.g. `minimal`/`low`/`medium`/
   * `high`/`xhigh`). Orthogonal to extended thinking. Forwarded to the runner
   * and only honoured by providers exposing discrete effort levels (Codex/
   * OpenRouter). Persisted in `company_templates.roles_json` (JSON field, no
   * schema change). Undefined → model default.
   */
  reasoningEffort?: string;
  /** Enable extended thinking for this role when supported by its provider. */
  thinking?: boolean;
  /** Provider-specific extended-thinking budget (currently used by Anthropic). */
  thinkingBudgetTokens?: number;
  /**
   * Ordered, user-authored fallback chain. An empty/absent chain means the
   * configured provider/model is authoritative and no model fallback is legal.
   */
  fallbackModels?: RoleFallbackModel[];
}

export interface CompanyTemplate {
  id: number;
  name: string;
  description: string;
  roles: CompanyRoleConfig[];
  created_at: string;
  updated_at: string;
}

/**
 * Entry in the per-session "allowed models" pool. When non-empty, the
 * master can only spawn subordinates using (provider, model) tuples
 * listed here. Replaces the previous free-form picking that let the
 * master hallucinate provider/model strings.
 */
export interface AllowedModel {
  provider: string;
  model: string;
  /** Short human label shown in the master's prompt (e.g. "Sonnet 4 — balanced"). */
  label?: string;
  /** Hint rendered to the master to guide selection (e.g. "cheap, use for trivia"). */
  notes?: string;
  /** When true, this entry is used when the master spawns without specifying provider/model. */
  is_default?: boolean;
}
