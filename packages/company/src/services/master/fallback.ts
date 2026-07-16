import { SessionStore } from '@mcp/code-agent/sessions/store.js';
import type { AllowedModel, CompanyRuntimeKind } from '@mcp/company/types.js';
import type { SessionContext } from '@mcp/company/services/SessionContext.js';
import type { IBoardPoster } from '@mcp/company/services/ports.js';
import { isTransientError } from '@mcp/company/RetryPolicy.js';
import { getAppStudioStore } from '@mcp/company/tools/app-studio/store-binding.js';

export const MASTER_EXPLICIT_FALLBACK_REASON = 'master_fallback_models';

function cleanModel(value: AllowedModel): AllowedModel | null {
  const provider = typeof value.provider === 'string' ? value.provider.trim() : '';
  const model = typeof value.model === 'string' ? value.model.trim() : '';
  return provider && model ? { ...value, provider, model } : null;
}

function modelKey(value: Pick<AllowedModel, 'provider' | 'model'>): string {
  return `${value.provider}\u0000${value.model}`;
}

/**
 * Pick the next entry in the immutable, user-configured Master fallback list.
 *
 * This deliberately has no allowed-model, provider, environment, or global
 * fallback branch. Generic Company keeps its existing runCoder fallback
 * behaviour; App Studio is the only runtime that consumes this lifecycle
 * chain because its runCoder-local chain is disabled for provenance safety.
 */
export function selectNextExplicitMasterFallback(input: {
  runtimeKind: CompanyRuntimeKind;
  configured: AllowedModel;
  current: AllowedModel;
  fallbackModels: readonly AllowedModel[];
}): AllowedModel | null {
  if (input.runtimeKind !== 'app_studio') return null;

  const configured = cleanModel(input.configured);
  const current = cleanModel(input.current);
  if (!configured || !current) return null;

  const seen = new Set<string>([modelKey(configured)]);
  const fallbacks: AllowedModel[] = [];
  for (const raw of input.fallbackModels) {
    const candidate = cleanModel(raw);
    if (!candidate) continue;
    const key = modelKey(candidate);
    if (seen.has(key)) continue;
    seen.add(key);
    fallbacks.push(candidate);
  }

  const currentKey = modelKey(current);
  if (currentKey === modelKey(configured)) return fallbacks[0] ?? null;
  const currentIndex = fallbacks.findIndex((candidate) => modelKey(candidate) === currentKey);
  return currentIndex >= 0 ? fallbacks[currentIndex + 1] ?? null : null;
}

export interface MasterFallbackDeps {
  ctx: SessionContext;
  board: Pick<IBoardPoster, 'post'>;
}

export interface AppliedMasterFallback {
  from: AllowedModel;
  to: AllowedModel;
  reason: string;
}

/** Update both the coder session and company provenance before retrying. */
export function applyExplicitMasterFallback(
  agentRunId: number,
  fallbackModels: readonly AllowedModel[],
  errorDetail: string,
  deps: MasterFallbackDeps,
): AppliedMasterFallback | null {
  if (deps.ctx.runtimeKind !== 'app_studio' || !isTransientError(errorDetail)) return null;

  const run = deps.ctx.companyStore.getAgentRun(agentRunId);
  if (!run || run.role !== 'master' || run.company_session_id !== deps.ctx.companySessionId) {
    return null;
  }

  const from = { provider: run.provider, model: run.model };
  const to = selectNextExplicitMasterFallback({
    runtimeKind: deps.ctx.runtimeKind,
    configured: {
      provider: run.configured_provider,
      model: run.configured_model,
    },
    current: from,
    fallbackModels,
  });
  if (!to) return null;

  const reason = `${MASTER_EXPLICIT_FALLBACK_REASON}: ${errorDetail.slice(0, 300)}`;
  const sessionStore = new SessionStore(deps.ctx.db.raw());
  try {
    sessionStore.updateSessionProvider(run.coder_session_id, to.provider, to.model);
    // Response ids are provider/model-specific. Preserve the transcript, but
    // force the next runner to reconstruct its turn graph from messages.
    sessionStore.setLastResponseState(run.coder_session_id, null, null);
  } finally {
    sessionStore.close();
  }

  deps.ctx.companyStore.updateAgentRunProvider(
    agentRunId,
    to.provider,
    to.model,
    reason,
  );
  deps.board.post(
    'system',
    agentRunId,
    'message',
    `[AUTO-FALLBACK] @master ${from.provider}/${from.model} -> ${to.provider}/${to.model} (explicit App role fallback).`,
  );

  if (deps.ctx.appStudioSessionId != null) {
    try {
      getAppStudioStore()?.appendEvent(
        deps.ctx.appStudioSessionId,
        'agents.model_fallback',
        'company_agent_run',
        String(agentRunId),
        JSON.stringify({ role: 'app_orchestrator', from, to, reason }),
        `app-master-fallback:${agentRunId}:${to.provider}:${to.model}`,
      );
    } catch {
      // Telemetry must never prevent an explicitly configured retry.
    }
  }

  return { from, to, reason };
}

/**
 * Cover provider/bootstrap failures thrown before runCoder can return a
 * handle. Runtime failures after a handle exists are handled by the Master
 * completion hook and use the same apply function.
 */
export async function runWithExplicitMasterFallback<T>(
  run: () => Promise<T>,
  agentRunId: number,
  fallbackModels: readonly AllowedModel[],
  deps: MasterFallbackDeps,
): Promise<T> {
  let appliedCount = 0;
  for (;;) {
    try {
      return await run();
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      // Defense in depth for a broken/stale store adapter: even if the
      // effective provider write is not observable on the next read, never
      // loop more times than the explicit chain supplied by the user.
      if (appliedCount >= fallbackModels.length) throw error;
      const applied = applyExplicitMasterFallback(agentRunId, fallbackModels, detail, deps);
      if (!applied) throw error;
      appliedCount += 1;
    }
  }
}
