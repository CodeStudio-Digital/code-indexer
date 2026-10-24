import type { RoleSkills, AllowedModel } from '@mcp/company/types.js';
export type RoleConfig = {
  role: string;
  enabled?: boolean;
  provider: string;
  model: string;
  tier: string;
  projectHints?: string[];
  /** Either a flat list of skill IDs or a `RoleSkillsConfig` object with
   *  `primary`/`chain`/`conditional`. Resolved via `resolveRoleSkills`
   *  before use. */
  skills?: RoleSkills;
  initialTools?: string[];
  systemPromptOverride?: string;
  /**
   * Concrete project ids this role is bound to in THIS session.
   * Set via the "Agents per project" UI; used by `SubordinateLifecycle.spawn`
   * for auto-resolve (when length === 1) and enforcement (rejects spawns to
   * project ids outside this list).
   */
  projectIds?: number[];
  /** Per-role sampling temperature (forwarded to the runner via
   *  `SubordinateLifecycle.spawn`). See `CompanyRoleConfig.temperature`. */
  temperature?: number;
  /**
   * Per-role sticky reasoning-effort override (e.g. `minimal`/`low`/`medium`/
   * `high`/`xhigh`). Orthogonal to `thinking`. Forwarded into
   * `runCoder({ reasoningEffort })` → `ChatRequest.reasoningEffort`. Only
   * honoured by providers exposing discrete effort levels (Codex/OpenRouter);
   * others ignore it. Undefined → model default. */
  reasoningEffort?: string;
  /**
   * Phase E: enable extended thinking ("deep reasoning") for subordinates
   * spawned with this role. Forwarded into `runCoder({ thinking })` →
   * `runner.opts.thinking`, which each provider adapter translates into
   * the appropriate API parameter (Anthropic `thinking.type=enabled`,
   * Gemini `reasoning`, etc.). Providers that don't support it ignore
   * the flag silently.
   *
   * `thinkingBudgetTokens` only matters for Anthropic — passed to the
   * SDK as `thinking.budget_tokens`. Defaults to provider-determined
   * (usually 5000) when undefined.
   *
   * Both fields are optional; absence is identical to legacy behaviour.
   */
  thinking?: boolean;
  thinkingBudgetTokens?: number;
  /** Ordered, explicit provider/model fallbacks for this role. */
  fallbackModels?: AllowedModel[];
};
