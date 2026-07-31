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
} from '@mcp/company/services/finalText.js';
import { logSkillOutcome } from '@mcp/company/services/subordinate/skill-telemetry.js';
import { subordinateCompletionBus } from '@mcp/company/services/subordinate/completion-events.js';
import {
  readRoleRuntimePolicy,
  resolveRoleFallback,
} from '@mcp/company/services/subordinate/role-runtime.js';

/**
 * Resume signature the completion handler invokes for auto-retry. Same
 * shape as `SubordinateLifecycle.resume` minus the bits the failure
 * path doesn't supply (role override, attachments, thinking).
 */
export type ResumeSubordinateFn = (
  agentRunId: string,
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
  /** Orchestrator facade retained for the lifecycle's shared deps shape. */
  orchestratorRef: unknown;
  runningIds: Set<string>;
  notifyIdleChanged: () => void;
  /**
   * Fences completion callbacks from an older runner after the same
   * agent_run has already been resumed with a new runner. Without this,
   * the old abort can overwrite the resumed run to `error` and remove its
   * id from `runningIds`.
   */
  isCurrentHandle?: (agentRunId: string, handle: RunCoderHandle) => boolean;
  resume: ResumeSubordinateFn;
  onSubordinateIdle?: (agentRunId: string, role: string) => void;
}

interface ModelFallbackResult {
  from: { provider: string; model: string };
  to: { provider: string; model: string };
  reason: string;
}

/**
 * Move the agent run to the next explicitly configured fallback before
 * retrying. A configured role may use only its own `fallbackModels` chain;
 * an unconfigured generic Company role may use the explicitly persisted
 * `allowed_models` pool. App Studio never falls through to that global pool.
 *
 * Returns `null` when no fallback is possible (no pool, only one
 * candidate, store write failed). All branches are logged.
 */
export async function applySubordinateModelFallback(
  agentRunId: string,
  role: string,
  deps: SubordinateCompletionDeps,
): Promise<ModelFallbackResult | null> {
  const agentRun = deps.ctx.companyFiles.getAgentRunSync(agentRunId);
  if (!agentRun) return null;

  const companySession = deps.ctx.companyFiles.getSession();
  const runtimeKind = companySession.runtime_kind;
  let policy: ReturnType<typeof readRoleRuntimePolicy>;
  try {
    policy = readRoleRuntimePolicy(
      companySession?.config_json,
      role,
      runtimeKind,
    );
  } catch (e) {
    console.warn(
      `[company] fallback policy is invalid for ${role}#${agentRunId}: ` +
      `${e instanceof Error ? e.message : String(e)}`,
    );
    return null;
  }
  const fallback = resolveRoleFallback({
    current: { provider: agentRun.provider, model: agentRun.model },
    runtimeKind: policy.runtimeKind,
    roleConfig: policy.roleConfig,
    allowedModels: policy.allowedModels,
  });
  if (!fallback) return null;

  const from = { provider: agentRun.provider, model: agentRun.model };
  const to = { provider: fallback.provider, model: fallback.model };

  try {
    const sessionStore = deps.ctx.companyFiles.sessionStore;
    await Promise.all([
      sessionStore.updateSessionProvider(
        agentRun.coder_session_id,
        to.provider,
        to.model,
      ),
      // A stored response id belongs to the previous provider/model turn
      // graph. Clear it so the resumed run starts with plain message history.
      sessionStore.setLastResponseState(
        agentRun.coder_session_id,
        null,
        null,
      ),
      deps.ctx.companyFiles.updateAgentRunProvider(
        agentRunId,
        to.provider,
        to.model,
        fallback.reason,
      ),
    ]);
    deps.board.post(
      'system',
      agentRunId,
      'message',
      `[AUTO-FALLBACK] (${fallback.reason}) @${role} ${from.provider}/${from.model} -> ${to.provider}/${to.model}`,
    );
    await deps.ctx.companyFiles.entities.create('log', {
      relations: { agent_run_id: agentRunId },
      data: {
        level: 'info',
        message: 'agents.model_fallback',
        event: 'agents.model_fallback',
        entity_kind: 'company_agent_run',
        entity_id: agentRunId,
        role,
        from,
        to,
        reason: fallback.reason,
        runtime_kind: runtimeKind,
      },
    }).catch(() => undefined);
    return { from, to, reason: fallback.reason };
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
/**
 * Best-effort parse of a provider `Retry-After` hint out of the free-text
 * error detail. Recognizes `retry-after: 12`, `retry after 12s`, and bare
 * `Retry-After 12000ms`. Returns the delay in ms, or undefined when absent.
 * Used only as a floor on the computed backoff — never as a hard schedule.
 */
function parseRetryAfterMs(detail: string | null | undefined): number | undefined {
  if (!detail) return undefined;
  const m = /retry[-\s]?after[:\s]+(\d+)\s*(ms|s|seconds?)?/i.exec(detail);
  if (!m) return undefined;
  const n = Number(m[1]);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  const unit = (m[2] ?? 's').toLowerCase();
  return unit.startsWith('ms') ? n : n * 1000;
}

export async function handleSubordinateFailure(
  agentRunId: string,
  role: string,
  summary: string,
  errorDetail: string | null,
  deps: SubordinateCompletionDeps,
): Promise<void> {
  await deps.ctx.companyFiles
    .updateAgentRunStatus(agentRunId, 'error', `Ended: ${summary}`)
    .catch(() => undefined);
  deps.runningIds.delete(agentRunId);
  deps.attention.signal({ kind: 'finished', agentRunId, role });
  deps.board.post('system', agentRunId, 'message', `@${role} ${summary}`);

  if (deps.retryPolicy.shouldRetry(agentRunId, errorDetail)) {
    const attempt = deps.retryPolicy.usedCount(agentRunId);
    const max = deps.retryPolicy.maxAttempts;
    const fallback = await applySubordinateModelFallback(
      agentRunId,
      role,
      deps,
    );
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

    // Wait out a bounded exponential backoff before retrying so a transient
    // provider error (429/5xx) isn't hammered on immediately. `retry-after`
    // from the provider, when present in the error text, is honored as a floor.
    const retryAfterMs = parseRetryAfterMs(errorDetail);
    const delayMs = deps.retryPolicy.backoffMs(agentRunId, retryAfterMs);
    const doResume = () =>
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
    if (delayMs > 0) {
      const t = setTimeout(doResume, delayMs);
      // Don't keep the worker alive solely for a pending retry during shutdown.
      (t as { unref?: () => void }).unref?.();
    } else {
      doResume();
    }
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
 * True when the run's current status is one the USER set deliberately
 * (`paused` or `aborted`). When the runner's `.done` settles after a
 * user pause/abort, the completion handler must NOT flip the run to
 * `error`, auto-retry it, or notify the master — the stop was intentional.
 * Reading the persisted status works because `pauseSubordinate` /
 * `abortSubordinate` write it synchronously before `.done` resolves.
 * Also hardens the pre-existing abort path against the same clobber.
 */
export function isUserStoppedRun(deps: SubordinateCompletionDeps, agentRunId: string): boolean {
  const status = deps.ctx.companyFiles.getAgentRunSync(agentRunId)?.status;
  // Missing row = the user deleted the agent mid-run → nothing to report
  // as a failure. `paused`/`aborted` = intentional stop.
  return status == null || status === 'paused' || status === 'aborted';
}

/**
 * Attach the `.then/.catch/.finally` chain that owns a subordinate's
 * lifecycle observability. Called once after the runner is created
 * (fresh spawn) or recreated (resume).
 */
export function attachSubordinateCompletionHandler(
  handle: RunCoderHandle,
  agentRunId: string,
  role: string,
  isResumed: boolean,
  deps: SubordinateCompletionDeps,
): void {
  const resumedTag = isResumed ? ' (resumed)' : '';

  handle.done
    .then(async ({ reason, error }) => {
      // A pause followed immediately by resume leaves the aborted runner's
      // `done` promise in flight. Its eventual completion belongs to an older
      // generation and must not mutate the replacement run.
      if (deps.isCurrentHandle && !deps.isCurrentHandle(agentRunId, handle)) {
        return;
      }
      if (reason === 'completed') {
        deps.retryPolicy.clear(agentRunId);
        await deps.ctx.companyFiles
          .updateAgentRunStatus(
            agentRunId,
            'waiting',
            'Task done. Ready for next task.',
          )
          .catch(() => undefined);
        deps.runningIds.delete(agentRunId);
        deps.attention.signal({ kind: 'finished', agentRunId, role });
        deps.board.post('system', agentRunId, 'deliverable',
          `@${role}${resumedTag} finished task. Status: **waiting** for next instructions.`);

        const finalText = await readFinalAssistantText(
          deps.ctx.companyFiles.sessionStore,
          handle.session.id,
        );
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
            // P16 — include the final assistant text as a "result
            // summary" comment so the operator and master can audit
            // what the subordinate produced without leaving the card.
            // Capped so a verbose final message doesn't bloat the
            // card's comment list.
            const summary = finalText
              ? finalText.length > 1500
                ? finalText.slice(0, 1500) + '\n\n[…truncated]'
                : finalText
              : '(no final assistant text — see board deliverable)';
            deps.kanban.addComment(cardId, role, agentRunId,
              `[AUTO] Agent completed successfully${resumedTag}.\n\n` +
              `**Result summary:**\n\n${summary}`);
          }
        } catch { /* best-effort */ }
        await logSkillOutcome(
          deps.ctx.companyFiles.sessionStore,
          handle.session.id,
          agentRunId,
          'success',
        );
        // C5 — fire-and-forget broadcast to any listeners that want to
        // react to completions OFF the response path (telemetry, role
        // history, kanban-sync extensions). Existing kanban/master
        // notifiers above ran SYNC; this bus is purely additive.
        try {
          subordinateCompletionBus.emit({
            agentRunId,
            role,
            outcome: 'completed',
            finalText: finalText
              ? finalText.length > 2000
                ? finalText.slice(0, 2000) + '\n\n[…truncated]'
                : finalText
              : undefined,
            kanbanCardId: deps.kanban.findCardForAgent(agentRunId) ?? null,
            emittedAtMs: Date.now(),
          });
        } catch (e) {
          console.warn('[company] completion-bus emit (success) threw:', e);
        }
        // Inbox drain: any pending inter-agent message targeted at
        // this run (or its role) is injected as the next prompt.
        // Best-effort — failures here must not break the completion
        // path. Fire-and-forget so the master gets its 'finished'
        // signal without waiting on the reactivate round-trip.
        if (deps.onSubordinateIdle) {
          try { deps.onSubordinateIdle(agentRunId, role); }
          catch (e) { console.warn('[company] inbox drain hook threw:', e); }
        }
      } else if (isUserStoppedRun(deps, agentRunId)) {
        // User paused/aborted this run (or deleted it) — preserve that
        // outcome. Skip the failure path entirely (no error flip, no
        // auto-retry, no master notify, no completion-bus 'failed').
        // `.finally` still drains runningIds + fires the idle hook.
        deps.runningIds.delete(agentRunId);
        deps.attention.signal({ kind: 'finished', agentRunId, role });
      } else {
        const detail = error ? ` — ${error}` : '';
        await handleSubordinateFailure(
          agentRunId,
          role,
          `${reason}${detail}`,
          error ?? null,
          deps,
        );
        await logSkillOutcome(
          deps.ctx.companyFiles.sessionStore,
          handle.session.id,
          agentRunId,
          'failed',
          error ?? undefined,
        );
        // C5 — broadcast the failure event too. Listeners differentiate
        // via `outcome: 'failed'` + `failureReason`.
        try {
          subordinateCompletionBus.emit({
            agentRunId,
            role,
            outcome: 'failed',
            failureReason: `${reason}${detail}`,
            kanbanCardId: deps.kanban.findCardForAgent(agentRunId) ?? null,
            emittedAtMs: Date.now(),
          });
        } catch (e) {
          console.warn('[company] completion-bus emit (failed) threw:', e);
        }
      }
    })
    .catch(async (err: unknown) => {
      if (deps.isCurrentHandle && !deps.isCurrentHandle(agentRunId, handle)) {
        return;
      }
      if (isUserStoppedRun(deps, agentRunId)) {
        // See the `.then` branch — a user-initiated stop must not be
        // reported as a failure.
        deps.runningIds.delete(agentRunId);
        deps.attention.signal({ kind: 'finished', agentRunId, role });
        return;
      }
      const detail = err instanceof Error ? err.message : String(err);
      await handleSubordinateFailure(
        agentRunId,
        role,
        `FAILED: ${detail}`,
        detail,
        deps,
      );
      // C5 — broadcast the synchronous-throw failure path too.
      try {
        subordinateCompletionBus.emit({
          agentRunId,
          role,
          outcome: 'failed',
          failureReason: `FAILED: ${detail}`,
          kanbanCardId: deps.kanban.findCardForAgent(agentRunId) ?? null,
          emittedAtMs: Date.now(),
        });
      } catch (e) {
        console.warn('[company] completion-bus emit (caught) threw:', e);
      }
    })
    .finally(() => {
      if (deps.isCurrentHandle && !deps.isCurrentHandle(agentRunId, handle)) {
        return;
      }
      deps.runningIds.delete(agentRunId);
      deps.notifyIdleChanged();
    });
}
