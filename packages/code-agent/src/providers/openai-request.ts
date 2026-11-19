import type { OpenAICompatVendor } from './openai-messages.js';
import type { ChatProvider, ChatRequest } from '@mcp/code-agent/providers/adapter.js';
import { getMaxOutputTokens } from '@mcp/code-agent/providers/capabilities.js';
import { getZaiModelReasoning } from '@mcp/shared/providers/zai-models.js';
export function normalizeDeepSeekEffort(value: string | null | undefined): 'high' | 'max' | null {
  const effort = value?.trim().toLowerCase();
  if (!effort || effort === 'none') return null;
  return effort === 'max' || effort === 'xhigh' || effort === 'ultra' ? 'max' : 'high';
}


export function normalizeMistralEffort(value: string | null | undefined): 'none' | 'high' | null {
  const effort = value?.trim().toLowerCase();
  if (!effort) return null;
  return effort === 'none' ? 'none' : 'high';
}


export function normalizeCopilotEffort(
  value: string | null | undefined,
): 'low' | 'medium' | 'high' | 'xhigh' | 'max' | null {
  const effort = value?.trim().toLowerCase();
  if (effort === 'low' || effort === 'medium' || effort === 'high' || effort === 'xhigh' || effort === 'max') {
    return effort;
  }
  return null;
}


export function copilotSupportsBooleanReasoningEffort(model: string): boolean {
  const id = model.trim().toLowerCase();
  return /^gpt-5\.(?:3-codex|4|5|6)(?:-|$)/.test(id)
    || /^claude-(?:fable-5|sonnet-(?:4\.6|5)|opus-(?:4\.[678]|5))(?:-|$)/.test(id)
    || /^gemini-3\.6-flash(?:-|$)/.test(id);
}


export function copilotUsesModelManagedReasoning(model: string): boolean {
  const id = model.trim().toLowerCase();
  const gemini3 = /^gemini-3(?:[.-]|$)/.test(id);
  return (gemini3 && !/^gemini-3\.6-flash(?:-|$)/.test(id))
    || /^kimi-k2\.7(?:-|$)/.test(id);
}


export function normalizeKimiK3Effort(value: string): 'none' | 'low' | 'high' | 'max' {
  const effort = value.trim().toLowerCase();
  if (effort === 'none') return 'none';
  if (effort === 'low' || effort === 'minimal' || effort === 'minimum' || effort === 'light') {
    return 'low';
  }
  if (effort === 'max' || effort === 'xhigh' || effort === 'ultra') return 'max';
  return 'high';
}


export function buildOpenAIRequestExtras(req: ChatRequest, vendor: OpenAICompatVendor, model: string,
  modelMaxOutputTokens?: Readonly<Record<string, number>>): Record<string, unknown> {
    // Z.AI / GLM extensions. These fields are not in the OpenAI SDK type but
    // the wire protocol is OpenAI-compatible; cast at the call site. Gated on
    // vendor+model family so DeepSeek/Copilot/OpenAI don't receive unknown params.
    const zaiExtras: Record<string, unknown> = {};
    if (vendor === 'zai') {
      zaiExtras.tool_stream = true;
      const reasoning = getZaiModelReasoning(model);
      if (reasoning) {
        const requested = req.reasoningEffort?.trim().toLowerCase();
        const selected = reasoning.supportedReasoningLevels.find(level => level === requested);
        zaiExtras.thinking = { type: 'enabled' };
        // A legacy request that only disables thinking maps to Low. The host
        // represents Auto as null after resolving any saved model default.
        const legacyDisabled = requested === 'none' || (req.reasoningEffort === undefined && req.thinking === false);
        zaiExtras.reasoning_effort = selected ?? (legacyDisabled ? 'low' : reasoning.defaultReasoningLevel);
      } else if (/^glm-(?:5(?:[.\-]|$)|4\.[567])/.test(model)) {
        // Retain the boolean control for earlier GLM models that accept it.
        zaiExtras.thinking = { type: req.thinking ? 'enabled' : 'disabled' };
      }
      // Keep the wire payload aligned with the model capability used for
      // context reservation. A provider-instance DB override wins; otherwise
      // use the DB/registry/fallback resolution chain.
      zaiExtras.max_tokens =
        modelMaxOutputTokens?.[model] ?? getMaxOutputTokens(model);
    }

    // DeepSeek V4 reasons by default and accepts high/max as discrete effort
    // values. The product's xhigh alias maps to the wire's max value.
    const deepseekExtras: Record<string, unknown> = {};
    if (vendor === 'deepseek') {
      const requestedEffort = req.reasoningEffort?.trim().toLowerCase();
      if (req.thinking === false || requestedEffort === 'none') {
        deepseekExtras.thinking = { type: 'disabled' };
      } else if (req.thinking === true || requestedEffort) {
        deepseekExtras.thinking = { type: 'enabled' };
      }
      const effort = normalizeDeepSeekEffort(req.reasoningEffort);
      if (effort) deepseekExtras.reasoning_effort = effort;
    }

    // OpenRouter normalizes reasoning controls across providers via the
    // `reasoning` parameter. An explicit effort override (composer/role) wins:
    // OpenRouter accepts `reasoning.effort` (low/medium/high) and maps it per
    // upstream model. Otherwise fall back to budget (when supplied) or the
    // model's default reasoning mode when `thinking` is on.
    const openrouterExtras: Record<string, unknown> = {};
    if (vendor === 'openrouter') {
      if (req.reasoningEffort) {
        openrouterExtras.reasoning = { effort: req.reasoningEffort, exclude: false };
      } else if (req.thinking === true) {
        openrouterExtras.reasoning =
          typeof req.thinkingBudgetTokens === 'number' && req.thinkingBudgetTokens > 0
            ? { max_tokens: req.thinkingBudgetTokens, exclude: false }
            : { enabled: true, exclude: false };
      }
    }

    // Mistral's current reasoning models return a structured ThinkChunk only
    // when reasoning_effort is enabled. Default to high for the boolean toggle
    // so the existing composer control has a visible effect.
    const mistralExtras: Record<string, unknown> = {};
    if (vendor === 'mistral') {
      const effort = normalizeMistralEffort(req.reasoningEffort)
        ?? (req.thinking === true ? 'high' : req.thinking === false ? 'none' : null);
      if (effort) mistralExtras.reasoning_effort = effort;
    }

    // GitHub Copilot's chat endpoint follows the same reasoning_effort contract
    // exposed by Copilot CLI. An explicit catalog-validated level remains
    // authoritative. The legacy boolean toggle maps to `high` only for model
    // families where Copilot documents configurable reasoning; fixed/adaptive
    // models (notably Gemini 3.5 Flash) must keep their server-side policy.
    const copilotExtras: Record<string, unknown> = {};
    if (vendor === 'copilot') {
      const modelManaged = copilotUsesModelManagedReasoning(model);
      const effort = modelManaged
        ? null
        : normalizeCopilotEffort(req.reasoningEffort)
          ?? (req.thinking === true && copilotSupportsBooleanReasoningEffort(model)
            ? 'high'
            : null);
      if (effort) copilotExtras.reasoning_effort = effort;
    }

    // Sakana Fugu reasons by default; its OpenAI-compatible Chat Completions takes
    // the discrete effort as the STRING field `reasoning_effort` (high/xhigh/max,
    // where xhigh==max). Forward the user-selected level when present; omitting it
    // lets Fugu apply its server-side default (xhigh). Gated on vendor so other
    // OpenAI-compatible vendors never receive the field.
    const fuguExtras: Record<string, unknown> = {};
    if (vendor === 'fugu' && req.reasoningEffort) {
      fuguExtras.reasoning_effort = req.reasoningEffort;
    }

    // Stable cache/routing hint per session. OpenRouter Chat Completions uses
    // `session_id` as its documented sticky-routing key; OpenAI uses
    // `prompt_cache_key`. Do not rely on OpenRouter silently accepting the
    // OpenAI-only field: without session_id a cold first request does not pin
    // the follow-up to the endpoint that owns the newly-written cache.
    const stableSessionId =
      req.sessionId != null ? `coder-session-${req.sessionId}` : null;
    const cacheKeyExtras: Record<string, unknown> =
      stableSessionId == null
        ? {}
        : vendor === 'openrouter'
          ? { session_id: stableSessionId }
          : { prompt_cache_key: stableSessionId };

    // OpenAI o-series and gpt-5 reasoning variants reject `temperature !== 1`.
    // The runner's resolver already filters these models, but guard here too
    // since this adapter is shared across vendors. Copilot has been observed
    // to reject `top_p` paired with `temperature` — we only send temperature
    // in this MVP, so that conflict can't occur.
    const isReasoningModel = /^(o[134]([\-.].*)?$|gpt-5.*reason)/i.test(model);
    // Legacy Kimi Code rows can still resolve through the generic OpenAI wire
    // (`provider_configs.id='kimi-code', kind='openai'`). K3 rejects every
    // temperature except 1, so enforce the invariant here as well as in the
    // dedicated Kimi adapter. This is deliberately keyed to the exact model id.
    const isKimiK3 = /^k3(?:-|$)/i.test(model);
    const temperature = isKimiK3
      ? 1
      : isReasoningModel ? undefined : req.inference?.temperature;

    const kimiK3Extras: Record<string, unknown> = {};
    if (isKimiK3 && req.reasoningEffort) {
      kimiK3Extras.reasoning_effort = normalizeKimiK3Effort(req.reasoningEffort);
    }

  return { ...(typeof temperature === 'number' ? { temperature } : {}), ...zaiExtras,
    ...deepseekExtras, ...openrouterExtras, ...mistralExtras, ...copilotExtras, ...fuguExtras,
    ...kimiK3Extras, ...cacheKeyExtras };
}
