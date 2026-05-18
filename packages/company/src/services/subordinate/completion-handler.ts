/**
 * Subordinate runner completion handling — the wrapper around
 * `handle.done.then/catch/finally` that turns runner outcomes into
 * the right side-effects (status flips, board posts, retry triggers,
 * master notifications).
 *
 * Two paths:
 *   1. Completed cleanly → mark waiting, signal attention, post final
 *      assistant text to master, drain inbox.
 *   2. Failed (any non-`completed` reason OR a `.catch` rejection) →
 *      delegate to `handleSubordinateFailure` which decides retry vs
 *      "tell the master".
 *
 * Auto-retry contract (`handleSubordinateFailure`):
 *   - If `RetryPolicy.shouldRetry` says yes → try a model fallback
 *     (via `applySubordinateModelFallback`), then call `resume()`.
 *   - Otherwise → notify master with a "use resume_subordinate" hint
 *     and add a kanban comment if the agent owned a card.
 *
 * Extracted from `SubordinateLifecycle` because the three methods form
 * a tight cluster and were the largest cohesive block left in that
 * file (~250 LOC).
 */
import type { RunCoderHandle, CoderAttachment } from '@mcp/code-agent/index.js';
import { SessionStore } from '@mcp/code-agent/sessions/store.js';
import { loadConfig } from '@mcp/shared/utils/config.js';
import type { AllowedModel } from '@mcp/company/types.js';
import type { SessionContext } from '@mcp/company/services/SessionContext.js';
import type { MasterAttention } from '@mcp/company/services/MasterAttention.js';
import type {
  IAgentStatusUpdater,
  IBoardPoster,
  IKanbanNotifier,
  IMasterNotifier,
} from '@mcp/company/services/ports.js';
import type { RetryPolicy } from '@mcp/company/RetryPolicy.js';
import {
  readFinalAssistantText,
} from '@mcp/company/services/subordinate/runner-wiring.js';
import { logSkillOutcome } from '@mcp/company/services/subordinate/skill-telemetry.js';

/**
 * Resume signature the completion handler invokes for auto-retry. Same
 * shape as `SubordinateLifecycle.resume` minus the bits the failure
 * path doesn't supply (role override, attachments, thinking).
 */
export type ResumeSubordinateFn = (
  agentRunId: number,
  message?: string,
  roleOverride?: string,
  attachments?: CoderAttachment[],
  thinking?: boolean,
) => Promise<unknown>;

export interface SubordinateCompletionDeps {
  ctx: SessionContext;
  board: IBoardPoster;
  status: IAgentStatusUpdater;
  kanban: IKanbanNotifier;
  master: IMasterNotifier;
  attention: MasterAttention;
  retryPolicy: RetryPolicy;
  /**
   * Orchestrator facade. We need `getAllowedModels` / `getPoolDefault`
   * for the model-fallback path. The cast in the consumer makes the
   * orchestrator ref opaque; we declare the narrow surface here.
   */
  orchestratorRef: unknown;
  runningIds: Set<number>;
  notifyIdleChanged: () => void;
  resume: ResumeSubordinateFn;
  onSubordinateIdle?: (agentRunId: number, role: string) => void;
}

interface ModelFallbackResult {
  from: { provider: string; model: string };
  to: { provider: string; model: string };
}

/**
 * Move the agent run to a different curated model before retrying.
 * Prefer the session's pool default; if the agent is already on it,
 * use the first OTHER allowed model. Updates both `coder_sessions`
 * (so the resumed runner picks up the new provider) and the
 * `agent_runs` row (UI consistency).
 *
 * Returns `null` when no fallback is possible (no pool, only one
 * candidate, store write failed). All branches are logged.
 */
export function applySubordinateModelFallback(
  agentRunId: number,
  role: string,
  deps: SubordinateCompletionDeps,
): ModelFallbackResult | null {
  const orchestratorForPool = deps.orchestratorRef as unknown as {
    getAllowedModels?: () => readonly AllowedModel[];
    getPoolDefault?: () => AllowedModel | null;
  };

  const agentRun = deps.ctx.companyStore.getAgentRun(agentRunId);
  if (!agentRun) return null;

  const allowedModels = orchestratorForPool.getAllowedModels?.() ?? [];
  const poolDefault = orchestratorForPool.getPoolDefault?.() ?? null;
  const candidates = [
    ...(poolDefault ? [poolDefault] : []),
    ...allowedModels,
  ];
  const fallback = candidates.find(
    (candidate) => candidate.provider !== agentRun.provider || candidate.model !== agentRun.model,
  );
  if (!fallback) return null;

  const from = { provider: agentRun.provider, model: agentRun.model };
  const to = { provider: fallback.provider, model: fallback.model };

  try {
    const config = loadConfig();
    const store = new SessionStore(config.dbPath);
    try {
      store.updateSessionProvider(agentRun.coder_session_id, to.provider, to.model);
      // A stored response id belongs to the previous provider/model turn
      // graph. Clear it so the resumed run starts with plain message history.
      store.setLastResponseState(agentRun.coder_session_id, null, null);
    } finally {
      store.close();
    }
    deps.ctx.companyStore.updateAgentRunProvider(agentRunId, to.provider, to.model);
    deps.board.post(
      'system',
      agentRunId,
      'message',
      `[AUTO-FALLBACK] @${role} ${from.provider}/${from.model} -> ${to.provider}/${to.model}`,
    );
    return { from, to };
  } catch (e) {
    console.warn(
      `[company] auto-fallback failed for ${role}#${agentRunId}: ` +
      `${e instanceof Error ? e.message : String(e)}`,
    );
    return null;
  }
}

/**
 * Classify a subordinate failure and react. Transient/provider errors
 * → auto-retry via `resume()` (with optional model fallback). Permanent
 * → bubble up to the master with a recovery hint + kanban comment.
 */
export function handleSubordinateFailure(
  agentRunId: number,
  role: string,
  summary: string,
  errorDetail: string | null,
  deps: SubordinateCompletionDeps,
): void {
  deps.status.setStatus(agentRunId, 'error', `Ended: ${summary}`);
  deps.runningIds.delete(agentRunId);
  deps.attention.signal({ kind: 'finished', agentRunId, role });
  deps.board.post('system', agentRunId, 'message', `@${role} ${summary}`);

  if (deps.retryPolicy.shouldRetry(agentRunId, errorDetail)) {
    const attempt = deps.retryPolicy.usedCount(agentRunId);
    const max = deps.retryPolicy.maxAttempts;
    const fallback = applySubordinateModelFallback(agentRunId, role, deps);
    deps.board.post('system', agentRunId, 'message',
      `[AUTO-RETRY] @${role} — transient error, retrying (${attempt}/${max})`);
    try {
      const cardId = deps.kanban.findCardForAgent(agentRunId);
      if (cardId) {
        const fallbackNote = fallback
          ? `; model fallback ${fallback.from.provider}/${fallback.from.model} -> ${fallback.to.provider}/${fallback.to.model}`
          : '';
        deps.kanban.addComment(cardId, role, agentRunId,
          `[AUTO-RETRY] Transient error${fallbackNote}; attempt ${attempt}/${max}: ${errorDetail ?? 'unknown'}`);
      }
    } catch { /* best-effort */ }

    void deps.resume(agentRunId,
      `[SYSTEM] Previous run ended with transient error (${errorDetail ?? 'unknown'}). ` +
      `Auto-retrying attempt ${attempt}/${max}. Continue the task.`,
    ).catch((e: unknown) => {
      console.warn(`[company] auto-retry failed for ${role}#${agentRunId}:`, e);
      deps.master.notify(
        `[SYSTEM] @${role} (agent_run_id=${agentRunId}) auto-retry FAILED to start: ${e instanceof Error ? e.message : String(e)}. ` +
        `Use resume_subordinate to retry manually or spawn_subordinate_agent for a fresh start.`,
      );
    });
    return;
  }

  // Permanent — notify master with recovery hint.
  deps.master.notify(
    `[SYSTEM] @${role} (agent_run_id=${agentRunId}) ended: ${summary}. ` +
    `Use resume_subordinate to retry or spawn_subordinate_agent for a fresh start.`,
  );
  try {
    const cardId = deps.kanban.findCardForAgent(agentRunId);
    if (cardId) {
      deps.kanban.addComment(cardId, role, agentRunId,
        `[AUTO] Agent ended: ${summary}. Card may need attention.`);
    }
  } catch { /* best-effort */ }
}

/**
 * Attach the `.then/.catch/.finally` chain that owns a subordinate's
 * lifecycle observability. Called once after the runner is created
 * (fresh spawn) or recreated (resume).
 */
export function attachSubordinateCompletionHandler(
  handle: RunCoderHandle,
  agentRunId: number,
  role: string,
  isResumed: boolean,
  deps: SubordinateCompletionDeps,
): void {
  const resumedTag = isResumed ? ' (resumed)' : '';

  handle.done
    .then(({ reason, error }) => {
      if (reason === 'completed') {
        deps.retryPolicy.clear(agentRunId);
        deps.status.setStatus(agentRunId, 'waiting', 'Task done. Ready for next task.');
        deps.runningIds.delete(agentRunId);
        deps.attention.signal({ kind: 'finished', agentRunId, role });
        deps.board.post('system', agentRunId, 'deliverable',
          `@${role}${resumedTag} finished task. Status: **waiting** for next instructions.`);

        const finalText = readFinalAssistantText(handle.session.id);
        const finalBlock = finalText
          ? `\n\n--- Final message from @${role} ---\n${finalText}`
          : `\n\n--- Final message from @${role} ---\n(no final assistant text message)`;

        deps.master.notify(
          `[SYSTEM] @${role} (agent_run_id=${agentRunId}${resumedTag}) completed and is WAITING. ` +
          `Use forward_to_agent to give it another task (keeps full context), ` +
          `or spawn_subordinate_agent for unrelated work.` +
          finalBlock,
        );
        try {
          const cardId = deps.kanban.findCardForAgent(agentRunId);
          if (cardId) {
            deps.kanban.addComment(cardId, role, agentRunId,
              `[AUTO] Agent completed successfully${resumedTag}. Status: waiting for next instructions.`);
          }
        } catch { /* best-effort */ }
        logSkillOutcome(handle.session.id, agentRunId, 'success');
        // Inbox drain: any pending inter-agent message targeted at
        // this run (or its role) is injected as the next prompt.
        // Best-effort — failures here must not break the completion
        // path. Fire-and-forget so the master gets its 'finished'
        // signal without waiting on the reactivate round-trip.
        if (deps.onSubordinateIdle) {
          try { deps.onSubordinateIdle(agentRunId, role); }
          catch (e) { console.warn('[company] inbox drain hook threw:', e); }
        }
      } else {
        const detail = error ? ` — ${error}` : '';
        handleSubordinateFailure(agentRunId, role, `${reason}${detail}`, error ?? null, deps);
        logSkillOutcome(handle.session.id, agentRunId, 'failed', error ?? undefined);
      }
    })
    .catch((err: unknown) => {
      const detail = err instanceof Error ? err.message : String(err);
      handleSubordinateFailure(agentRunId, role, `FAILED: ${detail}`, detail, deps);
    })
    .finally(() => {
      deps.runningIds.delete(agentRunId);
      deps.notifyIdleChanged();
    });
}
