/**
 * Glue between runCoder and a child-agent session run: attaches the profile
 * budget and the run fence to the runner, and finishes the run (salvage
 * summary as the final answer of a cut-off run, run record completion).
 * runCoder calls these only when loadChildAgentRun returned a configuration.
 */
import type { SessionId } from '@mcp/session-storage';
import type { FsSessionStore } from '@mcp/session-storage/fs-store/index.js';
import { ProviderStore } from '@mcp/store/provider-store.js';
import type { AgentMessage, ChatUsage } from '../core/messages.js';
import type { ToolContext } from '../core/tool.js';
import type { ChatProvider } from '../providers/adapter.js';
import { SUBAGENT_PROFILE_IDS, type MicroAgentProfileId } from '../tools/micro-agent-profiles.js';
import type { ProfileLimitOverride } from '../tools/subagent-provider.js';
import { attachChildAgentBudget, type BudgetedRunner } from './child-agent-budget.js';
import { startChildAgentFence, type ChildAgentFenceStore } from './child-agent-fence.js';
import type { ChildAgentRun } from './child-agent-run.js';
import { buildConclusion, changedFiles, conclusionState, trackFinalAnswer } from './child-agent-conclusion.js';

export interface ChildAgentRunGuards {
  /**
   * Salvage text that became the final answer, or null when the run ended on
   * its own. Without `usage` (the run threw), the committed messages' usage counts.
   */
  finish(result: { reason: string; usage?: ChatUsage }): Promise<string | null>;
  dispose(): void;
}

/**
 * Reads the creator provider's subagent config; logs instead of failing when
 * it cannot (the caller falls back to product defaults or the creator's own
 * model). The connection is always closed.
 */
function readProviderConfig<T>(dbPath: string, providerId: string, what: string, read: (store: ProviderStore) => T): T | undefined {
  let store: ProviderStore | null = null;
  try {
    store = new ProviderStore(dbPath);
    // An unknown or unavailable provider keeps no subagent config: say so,
    // since the Admin settings would otherwise be ignored silently.
    if (!store.getProvider(providerId)) {
      console.warn(`[child-agent] ${what} unavailable: provider "${providerId}" is not configured or not available; defaults apply`);
      return undefined;
    }
    return read(store);
  } catch (error) {
    console.warn(`[child-agent] ${what} could not be read for provider "${providerId}": ${error instanceof Error ? error.message : String(error)}; defaults apply`);
    return undefined;
  } finally {
    store?.close();
  }
}

/** Admin per-profile hard-cap overrides, read once like the in-process resolver does. */
export function profileLimitsFromProviderStore(
  dbPath: string,
  providerId: string,
): ((profileId: string) => ProfileLimitOverride | undefined) | undefined {
  const limits = readProviderConfig(dbPath, providerId, 'Admin per-profile limits', (store) => new Map(
    SUBAGENT_PROFILE_IDS.map((id) => [id as string, store.getSubagentProfileLimits(providerId, id as MicroAgentProfileId)]),
  ));
  return limits ? (id) => limits.get(id) ?? undefined : undefined;
}

/** The profile model/effort resolver child creation uses (consumed by E6). */
export function profileTargetsFromProviderStore(
  dbPath: string,
): ((creatorProvider: string, profileId: string) => { provider: string | null; model: string | null; effort: string | null } | undefined) {
  return (creatorProvider, profileId) => readProviderConfig(dbPath, creatorProvider, 'Admin per-profile model', (store) => {
    const target = store.getSubagentProfileTarget(creatorProvider, profileId);
    const effort = store.getSubagentProfileEffort(creatorProvider, profileId);
    return { provider: target?.providerId ?? null, model: target?.modelId ?? null, effort };
  });
}

export async function startChildAgentRunGuards(input: {
  run: ChildAgentRun;
  store: ChildAgentFenceStore & Pick<FsSessionStore, 'appendMessage' | 'recordChildAgentConclusion'>;
  sessionId: SessionId;
  runner: BudgetedRunner & { readonly runId: string; readonly turn: number; readonly messages: AgentMessage[] };
  toolContext: ToolContext;
  provider: ChatProvider;
  effort?: string | null;
  capabilities: readonly string[];
  systemPrompt: () => string;
  signal?: AbortSignal;
}): Promise<ChildAgentRunGuards> {
  const { run, store, runner } = input;
  let violation: string | null = null;
  // Cutoffs cancel in-flight provider and tool work through the run's signal.
  const cutoff = new AbortController();
  input.toolContext.signal = input.toolContext.signal
    ? AbortSignal.any([input.toolContext.signal, cutoff.signal])
    : cutoff.signal;
  const budget = attachChildAgentBudget(runner, run, input.systemPrompt, {
    onCutoff: (message) => cutoff.abort(new Error(message)),
  });
  const fence = await startChildAgentFence(store, {
    sessionId: input.sessionId,
    runId: runner.runId,
    run,
    cwd: input.toolContext.cwd,
    roots: input.toolContext.roots,
    externalRoots: input.toolContext.externalRoots,
    unrestrictedFilesystemAccess: input.toolContext.unrestrictedFilesystemAccess,
    provider: input.provider.name,
    model: input.provider.model,
    effort: input.effort,
    capabilities: input.capabilities,
    onViolation: (message) => {
      violation = message;
      try { runner.abort(); } catch { /* already terminal */ }
      cutoff.abort(new Error(message));
    },
  }).catch((error: unknown) => {
    budget.cleanup();
    throw error;
  });
  input.toolContext.mutationFence = fence.mutationFence;
  const answer = trackFinalAnswer(runner);

  let disposed = false;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    budget.cleanup();
    fence.stop();
    answer.stop();
  };
  // The success path and the error path may both finish; only the first runs.
  let finished: Promise<string | null> | null = null;
  const finishOnce = async (ended: { reason: string; usage?: ChatUsage }): Promise<string | null> => {
    const result = { reason: ended.reason, usage: ended.usage ?? answer.usage() };
    const cutReason = budget.cutoff();
    let salvage: string | null = null;
    try {
      if (cutReason) {
        const summary = await budget.salvage(input.provider, runner.messages, input.signal);
        salvage = summary.text;
        await store.appendMessage({
          session_id: input.sessionId,
          message: { role: 'assistant', content: [{ type: 'text', text: salvage }] },
        });
      }
      // The conclusion first: a parent waiting again after a restart reads it,
      // and the run record completion below only releases the queue slot.
      await store.recordChildAgentConclusion(input.sessionId, buildConclusion({
        runId: runner.runId,
        state: conclusionState({ cutoff: cutReason, violation, reason: result.reason }),
        reason: cutReason ?? violation ?? result.reason,
        finalText: salvage ?? answer.text(),
        changedFiles: await changedFiles(input.toolContext),
        usage: result.usage,
      }));
      await fence.complete({
        reason: cutReason ? 'watchdog' : violation ? 'fence_violation' : result.reason,
        turns: runner.turn,
        toolCalls: budget.toolCalls(),
        usage: result.usage,
        hasSummary: salvage != null,
      });
    } finally {
      dispose();
    }
    return salvage;
  };
  return {
    finish: (result) => (finished ??= finishOnce(result)),
    dispose,
  };
}
