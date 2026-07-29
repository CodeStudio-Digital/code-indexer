/**
 * Auto-temperature resolution.
 *
 * Computes the sampling temperature the runner should send to the provider
 * for a given turn. The value cascades through a precedence chain — session
 * override > company role override > agent preset > global default — and is
 * suppressed entirely (returns `undefined`) for models that reject or ignore
 * sampling (OpenAI o-series, Anthropic with extended thinking).
 *
 * Why this lives in its own module: the runner shouldn't carry policy logic,
 * and the same resolver is reused by tests and (eventually) by the dashboard
 * to preview the effective T before a turn fires.
 */
import type { AgentId } from '@mcp/code-agent/agents/index.js';
import { AGENTS } from '@mcp/code-agent/agents/index.js';

/** Fallback when no agent / role / session override applies. */
export const DEFAULT_TEMPERATURE = 0.3;

/**
 * Models that reject `temperature !== 1` or ignore the parameter entirely.
 * Match prefixes/families rather than exact ids so future variants are caught
 * without code changes (`o3-mini`, `o4-preview`, `gpt-5-reasoning-…`).
 */
const REASONING_MODEL_PATTERN = /^(o[134]([\-.].*)?$|gpt-5.*reason)/i;

export type TemperatureSource =
  | 'session'
  | 'role'
  | 'agent'
  | 'default'
  | 'skipped';

export interface TemperatureResolutionContext {
  agent: AgentId | null;
  providerName: string;
  model: string;
  thinking?: boolean;
  /** Per-session override from the filesystem state projection. */
  sessionOverride?: number | null;
  /** Per-role override from `CompanyRoleConfig.temperature` (company mode). */
  roleOverride?: number | null;
}

export interface TemperatureResolution {
  temperature: number | undefined;
  source: TemperatureSource;
  /** Populated when `source === 'skipped'`. */
  reason?: 'reasoning_model' | 'thinking_enabled';
}

/**
 * Returns whether the given (provider, model, thinking) tuple should skip
 * sending temperature altogether.
 */
function shouldSkip(ctx: TemperatureResolutionContext): TemperatureResolution['reason'] | null {
  if (REASONING_MODEL_PATTERN.test(ctx.model)) return 'reasoning_model';
  // Anthropic extended thinking and Kimi K2/thinking models require fixed
  // sampling (or ignore sampling), so omit temperature. Other providers handle
  // thinking via separate fields and don't conflict with temperature.
  if (ctx.thinking === true && ctx.providerName === 'anthropic') return 'thinking_enabled';
  if (
    ctx.providerName === 'kimi-code' &&
    (ctx.thinking === true || /thinking|^kimi-k2\.(5|6)/i.test(ctx.model))
  ) {
    return 'thinking_enabled';
  }
  return null;
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return DEFAULT_TEMPERATURE;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

/**
 * Resolve the temperature for the upcoming `provider.chat()` call.
 *
 * Precedence (highest first):
 *   1. session override   — manual user tuning per conversation
 *   2. role override      — `CompanyRoleConfig.temperature` (company mode)
 *   3. agent preset       — `AgentDefinition.defaultTemperature`
 *   4. global default     — `DEFAULT_TEMPERATURE`
 *
 * Returns `temperature: undefined` and `source: 'skipped'` when the model
 * cannot accept sampling.
 */
export function resolveTemperature(ctx: TemperatureResolutionContext): TemperatureResolution {
  const skip = shouldSkip(ctx);
  if (skip) return { temperature: undefined, source: 'skipped', reason: skip };

  if (typeof ctx.sessionOverride === 'number') {
    return { temperature: clamp01(ctx.sessionOverride), source: 'session' };
  }
  if (typeof ctx.roleOverride === 'number') {
    return { temperature: clamp01(ctx.roleOverride), source: 'role' };
  }
  if (ctx.agent && AGENTS[ctx.agent]) {
    const agentT = AGENTS[ctx.agent].defaultTemperature;
    if (typeof agentT === 'number') {
      return { temperature: clamp01(agentT), source: 'agent' };
    }
  }
  return { temperature: DEFAULT_TEMPERATURE, source: 'default' };
}
