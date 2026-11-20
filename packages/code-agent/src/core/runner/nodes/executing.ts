import { toolProjectionReceipt } from '../../tool-projection.js';
import { suppressesMemoryRecall } from '@mcp/shared/memory-opt-out.js';
import { outcomeRecoveryPrompt } from '../../uncertain-tool-outcome.js';
import { synchronizeOutcomeRecovery } from '../outcome-recovery.js';
import { rejectedProviderTools, toolSchemaRecoveryPrompt } from '../provider-schema-recovery.js';
import { toolExtraUserMessages } from '../../tool-extra-user-messages.js';
import { projectVisionContext } from '../../vision-context.js';
import { BoundaryPreparation } from '../boundary-preparation.js';
import { TurnPersistenceBarrier } from '../turn-persistence-barrier.js';
/**
 * Executing node — drives ONE full provider turn.
 *
 * Pipeline:
 *   1. bump `ctx.turn`, emit `turn_start`.
 *   2. assemble messages (via assembly + bridge callbacks for skills /
 *      active-context).
 *   3. build tools (via assembly).
 *   4. use the configured system prompt.
 *   5. stream `provider.chat()` with the full ChatRequest legacy passes.
 *   6. push assistant message.
 *   7. dispatch tools — pre-read + tuple-hash gates, smart-reducer +
 *      polling-stuck on results.
 *   8. push tool-role message, emit per-tool telemetry.
 *   9. decide next event:
 *        - dedup refusal         → ToolLoopDetected (→ Planning)
 *        - token usage ≥ 90% eff → TokenThresholdHit (→ Compacting)
 *        - assistant text only   → CleanFinish
 *        - turn == maxTurns      → MaxTurnsReached or auto-continue
 *        - otherwise             → TurnSucceeded
 */
import type { BehaviorEvent, BehaviorNode, RunContext } from '../machine/types.js';
import type { ChatDelta, ContentBlock } from '@mcp/code-agent/core/messages.js';
import type { ProviderAttemptTelemetry } from '@mcp/code-agent/providers/adapter.js';
import type { AgentRunId } from '@mcp/agent-runtime-contracts';
import { promptTokensTotal } from '@mcp/code-agent/core/messages.js';
import { bindProviderReplay } from '@mcp/code-agent/core/provider-replay.js';
import { deriveTokenLimits } from '@mcp/code-agent/core/compaction/limits.js';
import { events } from '../machine/events.js';
import { accumulateUsage, resetProviderRetrySequence } from '../machine/context.js';
import { providerTransportError } from '@mcp/provider-sdk/transport-error.js';
import { envTunables } from '@mcp/code-agent/core/tunables.js';
import { assembleMessagesForChat } from '../assembly/messages.js';
import { buildTools, buildToolsCacheKey, fingerprintToolsJson, type BuildToolsResult } from '../assembly/tools.js';
import { computePrefixHeadHash } from '../telemetry/prefix-head.js';
import { resolveToolMetadata } from '@mcp/code-agent/core/policy.js';
import { approvedPlanForRevision } from '@mcp/code-agent/tools/plan.js';
import { resolveProviderCapabilityProjection } from '@mcp/code-agent/core/capability-catalog.js';
import { shouldCompact90 } from '../compaction/threshold.js';
import { maybeKickSummaryPrecompute, shouldKickPrecompute } from '../compaction/precompute.js';
// PR-F integration — Codex BodyAfterPrefix (post-response, prefix-cache-aware
// trigger) + Kimi pre-emit (pre-provider-call estimate so the request that
// would tip the window over doesn't even go out). Both gates compose with
// the legacy `shouldCompact90` — that one stays as a safety net for paths
// where prefix-cache isn't reliable.
import {
  computePrefixTokens,
  shouldCompactBodyAfterPrefix,
} from '../compaction/prefix-window.js';
import { shouldCompactPreEmit, estimateMessagesTokens } from '../compaction/pending-tokens.js';
import { evaluateLoopAwareCompaction } from '../compaction/loop-aware-trigger.js';
import { computeDynamicInjection, type DynamicInjectionResult } from '../assembly/dynamic-injection.js';
import { detectCorrectionSignal, renderCorrectionHint } from '../assembly/correction-nudge.js';
import {
  renderSessionStateBlock,
  renderMemoryIndex,
  renderConversationChapterIndex,
  renderUserMemoryBlock,
  hashSessionState,
} from '../assembly/session-state.js';
import { resolveInjectionPolicy } from '../assembly/injection-policy.js';
import { applySelfReviewDecline, computeSelfReviewNudge } from './executing-self-review.js';
import {
  latestUserTaskText,
  planMemoryRecall,
  buildConversationTail,
} from '../memory-query.js';
import { maybePlanNudge } from './executing-plan-gate.js';
import { evaluateVerificationReadinessAtFinish, maybeVerificationNudge } from './executing-verification-gate.js';
import { consumeStream } from './executing-stream.js';
import { dispatchTools, buildToolMessage, type DispatchedToolResult } from './executing-dispatch.js';
import { drainBackgroundNotices } from '../../background-notices.js';
import { buildNestedToolObserver, nestedGuardsEnabled } from '../guards/nested-observer.js';
import { evaluatePerTurnLoops } from './executing-loop-guards.js';
import { applyVisionFallback } from '../vision-fallback.js';
import { getGlobalVisionDescriber } from '@mcp/code-agent/core/vision-describer.js';
import {
  decideTerminal,
  providerErrorEvent,
} from './executing-decisions.js';
import { withAbort, isAbortError } from './executing-abort.js';
import { estimateCost } from '@mcp/code-agent/providers/pricing-cache.js';
import {
  promoteDynamicToolPin,
  touchDynamicToolPin,
} from '@mcp/code-agent/tools/tool-pin-window.js';

const DEBUG = process.env.CODER_BT_DEBUG === '1';
function dbg(...args: unknown[]): void {
  if (DEBUG) console.log('[bt-debug]', ...args);
}

function fallbackAttemptErrorMeta(error: unknown, fallbackCode: string): {
  status: number | null;
  requestId: string | null;
  retryAfter: string | null;
  errorCode: string;
  errorMessage: string;
} {
  const record = error && typeof error === 'object'
    ? error as {
        status?: unknown;
        statusCode?: unknown;
        code?: unknown;
        request_id?: unknown;
        requestId?: unknown;
        headers?: unknown;
        responseMeta?: {
          response?: {
            status?: unknown;
            request_id?: unknown;
            retry_after?: unknown;
          };
        };
      }
    : {};
  const status = typeof record.status === 'number'
    ? record.status
    : typeof record.statusCode === 'number'
      ? record.statusCode
      : typeof record.responseMeta?.response?.status === 'number'
        ? record.responseMeta.response.status
        : null;
  const header = (name: string): string | null => {
    if (!record.headers || typeof record.headers !== 'object') return null;
    const getter = (record.headers as { get?: unknown }).get;
    if (typeof getter === 'function') {
      const value = getter.call(record.headers, name);
      return typeof value === 'string' && value.length > 0 ? value : null;
    }
    const value = (record.headers as Record<string, unknown>)[name];
    return typeof value === 'string' && value.length > 0 ? value : null;
  };
  const transport = providerTransportError(error);
  const rawCode = transport?.code ?? (typeof record.code === 'string' ? record.code : fallbackCode);
  const safeCode = rawCode.replace(/[^a-zA-Z0-9_.:-]/g, '_').slice(0, 128);
  return {
    status,
    requestId:
      typeof record.request_id === 'string'
        ? record.request_id
        : typeof record.requestId === 'string'
          ? record.requestId
          : typeof record.responseMeta?.response?.request_id === 'string'
            ? record.responseMeta.response.request_id
            : header('x-request-id'),
    retryAfter:
      typeof record.responseMeta?.response?.retry_after === 'string'
        ? record.responseMeta.response.retry_after
        : header('retry-after'),
    errorCode: safeCode || fallbackCode,
    // Only our allowlisted transport diagnostic is safe to persist; arbitrary
    // SDK messages may contain prompts, signed URLs or credentials.
    errorMessage: transport?.message ?? (error instanceof Error ? error.name : 'UnknownError'),
  };
}

/**
 * Concise list of the tools this agent can call right now — registry filtered
 * by the active tiers (the same set the model is advertised), each with a
 * one-line description. Feeds the loop-enforcement reminder so the agent is
 * reminded what to do INSTEAD of the call it keeps repeating.
 */
const proactiveRecall = new WeakMap<object, BoundaryPreparation<ReadonlyArray<(() => void) | undefined>>>();

export class ExecutingNode implements BehaviorNode {
  readonly state = 'Executing' as const;

  async execute(ctx: RunContext, _lastEvent: BehaviorEvent | null): Promise<BehaviorEvent> {
    ctx.turn++;
    const preparationStartedAt = performance.now();
    ctx.emit('turn_start', ctx.turn);
    // The transcript is already in RAM. Only verified inference-only providers
    // may read it while the preceding turn is flushing; all effects and terminal
    // completion still wait for durability, and a failed flush cancels inference.
    const persistence = new TurnPersistenceBarrier(() => ctx.bridge?.awaitTurnPersistence?.());
    try {
    if (ctx.opts.provider.inferenceOnly !== true || process.env.CODER_OVERLAP_PERSISTENCE === '0') {
      await persistence.wait();
    }
    // Drain any messages queued via `runner.pushUserMessage` (master →
    // subordinate forward, SSE-side push from the dashboard, etc.) so
    // they appear in `ctx.messages` BEFORE we build the request. The
    // legacy while-loop did this at the same point in the cycle; the
    // BT delegates to the bridge so the queue (`pendingUserMessages`)
    // stays owned by the host `CoderRunner` class.
    ctx.bridge?.flushPendingMessages?.();
    dbg(`Executing turn=${ctx.turn} messages=${ctx.messages.length}`);

    // Fix A — honor an explicit user "stop reviewing" instruction (session 887).
    applySelfReviewDecline(ctx, latestUserTaskText(ctx.messages));

    // Mem C — proactive project-memory retrieval. Async, so it runs HERE
    // (before the synchronous message assembly) and stashes the result in
    // injectionState for the dynamic injector to surface. Throttled: only the
    // first turn or when the task text materially changes, so we don't re-query
    // (or re-inject) every turn.
    ctx.injectionState.pendingMemory = undefined;
    ctx.injectionState.pendingConversationChapters = undefined;
    // Honor an explicit "ignore / don't use memory" instruction this turn — skip
    // proactive recall so no remembered facts are surfaced or applied (CC's
    // ignore-memory rule). EN + PT-BR phrasings.
    const memoryTaskText = latestUserTaskText(ctx.messages);
    // "ignore/don't use memory" instruction gate. Tightened against benign
    // coding phrases: no bare "sem" ("sem estourar a memória"), and "memory"
    // followed by leak/usage/check/heap-style words is the RESOURCE, not the
    // agent memory feature ("ignore the memory leak for now").
    const ignoreMemory = suppressesMemoryRecall(memoryTaskText);
    ctx.opts.toolContext.memoryReadSuppressed = ignoreMemory;
    // Perf W1 — the two recall blocks below are independent (distinct
    // injectionState fields + throttle keys) yet ran serially, both awaited
    // on the critical path before the provider call. Run them concurrently;
    // the internal synthesize→retrieve dependency of the project-memory
    // block is preserved inside its closure.
    const recallTurn = ctx.turn;
    const recallProjectMemory = async (): Promise<(() => void) | undefined> => {
      if (ignoreMemory || !ctx.bridge?.getRelevantProjectMemory) return;
      // Derive the recall query + throttle verdict (pure). A normal message IS
      // the query; a META / continuation ("continue", "Reanalise tudo que fez,
      // se não deixou passar nada!") carries no task semantics, so the raw text
      // yields `zero_hits` — `planMemoryRecall` walks back to the last
      // substantive message and throttles on that STABLE `candidate`.
      const { candidate, meta, shouldRetrieve } = planMemoryRecall(
        memoryTaskText,
        ctx.messages,
        ctx.injectionState.lastMemoryQuery,
        ctx.turn,
      );
      if (!shouldRetrieve) return;
      // Only for a meta message do we spend the (paid, on-critical-path) LLM
      // synthesizer to sharpen the walk-back query; fail-open to the candidate.
      let memoryQuery = candidate;
      if (meta && ctx.bridge.synthesizeMemoryQuery) {
        try {
          const synthesized = await ctx.bridge.synthesizeMemoryQuery(buildConversationTail(ctx.messages));
          if (synthesized) memoryQuery = synthesized;
        } catch (e) {
          dbg('memory query synthesis failed', (e as Error).message);
        }
      }
      try {
        const recalled = await ctx.bridge.getRelevantProjectMemory(memoryQuery, recallTurn);
        return () => {
          ctx.injectionState.pendingMemory = recalled;
          ctx.injectionState.lastMemoryQuery = candidate;
        };
      } catch (e) {
        dbg('memory retrieval failed', (e as Error).message);
      }
    };

    // Session-local history uses the same material-task-change throttle as
    // project memory, but retrieval is independently bounded to two excerpts.
    const recallConversationChapters = async (): Promise<(() => void) | undefined> => {
      if (!ctx.bridge?.getRelevantConversationChapters) return;
      const { candidate, shouldRetrieve } = planMemoryRecall(
        memoryTaskText,
        ctx.messages,
        ctx.injectionState.lastConversationChapterQuery,
        ctx.turn,
      );
      if (!shouldRetrieve || !candidate.trim()) return;
      try {
        const recalled = await ctx.bridge.getRelevantConversationChapters(candidate, recallTurn);
        return () => {
          ctx.injectionState.pendingConversationChapters = recalled;
          ctx.injectionState.lastConversationChapterQuery = candidate;
        };
      } catch (e) {
        dbg('conversation chapter retrieval failed', (e as Error).message);
      }
    };
    let preparation = proactiveRecall.get(ctx);
    if (!preparation) {
      preparation = new BoundaryPreparation();
      proactiveRecall.set(ctx, preparation);
    }
    const recalled = await preparation.take(
      memoryTaskText ?? '',
      () => Promise.all([recallProjectMemory(), recallConversationChapters()]),
      ctx.opts.toolContext.signal,
    );
    for (const apply of recalled ?? []) apply?.();

    let durableConversationChapterIndex: Awaited<
      ReturnType<
        NonNullable<
          NonNullable<typeof ctx.bridge>['getConversationChapterIndex']
        >
      >
    > = null;
    try {
      durableConversationChapterIndex =
        (await ctx.bridge?.getConversationChapterIndex?.()) ?? null;
    } catch (e) {
      dbg(
        'conversation-chapter-index load failed',
        (e as Error).message,
      );
    }
    const selfReviewNudgeForTurn = await computeSelfReviewNudge(ctx);

    // Correction nudge — the user's last message looks like a correction or a
    // durable preference: suggest remember() THIS turn. Cheap regex, throttled
    // (once per distinct message hash, ≤3/run — see injectionState docs).
    // Gated to single sessions (getProjectMemoryIndex is only wired outside
    // company contexts — a subordinate's "user" is the master, not a person).
    let correctionHint: string | null = null;
    const nudgeState = ctx.injectionState.correctionNudge;
    if (!ignoreMemory && memoryTaskText && nudgeState.count < 3 && ctx.bridge?.getProjectMemoryIndex) {
      const signal = detectCorrectionSignal(memoryTaskText);
      if (signal && hashSessionState(memoryTaskText) !== nudgeState.lastHash) {
        correctionHint = renderCorrectionHint(signal);
      }
    }

    const tunables = ctx.opts.tunables ?? envTunables();
    // PR-F dynamic injection — invoke the provider once per assembly so
    // the post-injection state updates are coherent. The pure
    // `computeDynamicInjection` decides whether anything fresh is worth
    // reminding the model about; we wrap it in a closure that hits the
    // bridge for the live signals (newly-registered skills, recently
    // edited files). The Compacting node also bumps
    // `injectionState.recentCompactionAt`, so a compaction in the last
    // ≤2 turns produces a "context was summarized" reminder here.
    let injectionResultForCommit: DynamicInjectionResult | null = null;
    // B1/G3 — skills whose bodies are (re)injected this turn = the trailing user
    // message's selectedSkillIds (same source `buildActiveSkillsBlock` uses).
    // Captured here so both the injector (to flag already-executed skills
    // post-compaction) and the post-assembly commit (to record them) can use it.
    let activeSkillIdsThisTurn: string[] = [];
    for (let i = ctx.messages.length - 1; i >= 0; i--) {
      if (ctx.messages[i]!.role === 'user') {
        activeSkillIdsThisTurn = ctx.messages[i]!.selectedSkillIds ?? [];
        break;
      }
    }
    const dynamicInjectionFn = (): DynamicInjectionResult | null => {
      const signals = ctx.bridge?.collectDynamicInjectionSignals?.() ?? null;
      const recentCompactionAt = ctx.injectionState.recentCompactionAt;
      const pendingMemory = ctx.injectionState.pendingMemory ?? [];
      const pendingConversationChapters = ctx.injectionState.pendingConversationChapters ?? [];
      // self_review nudge — gated (Fix A) so it fires only for UNREVIEWED
      // pending changes and hard-stops after a cap / explicit user decline,
      // instead of every turn while any snapshot is pending (the doom-loop).
      const selfReviewNudge = selfReviewNudgeForTurn;
      // Session State Block — the always-alive structured state (plan/
      // todos/notes/files/recall) rendered from persisted data, sized and
      // paced by the window-scaled policy. Replaces the old per-field drive
      // injection. Short windows inject it EVERY turn; standard windows on
      // milestones or when the block's hash changes.
      const policy = resolveInjectionPolicy(ctx.opts.provider.model, {
        liveStateCovered: !!ctx.opts.agentLoopV2,
      });
      let sessionState: { block: string; hash: string } | null = null;
      let projectMemoryIndex: { text: string; hash: string } | null = null;
      let conversationChapterIndex: { text: string; hash: string } | null = null;
      let userMemoryIndex: { text: string; hash: string } | null = null;
      if (policy.enabled) {
        try {
          const data = ctx.bridge?.getSessionStateData?.() ?? null;
          if (data) {
            const block = renderSessionStateBlock(data, policy.budget);
            if (block) sessionState = { block, hash: hashSessionState(block) };
          }
        } catch (e) {
          dbg('session-state render failed', (e as Error).message);
        }
        if (!ignoreMemory && policy.memoryIndexChars > 0) {
          try {
            const entries = ctx.bridge?.getProjectMemoryIndex?.() ?? null;
            const text = entries ? renderMemoryIndex(entries, policy.memoryIndexChars) : null;
            if (text) projectMemoryIndex = { text, hash: hashSessionState(text) };
          } catch (e) {
            dbg('memory-index render failed', (e as Error).message);
          }
        }
        if (policy.chapterIndexChars > 0) {
          try {
            const chapterIndex = durableConversationChapterIndex;
            const text = chapterIndex
              ? renderConversationChapterIndex(
                  chapterIndex.entries,
                  chapterIndex.total,
                  policy.chapterIndexChars,
                )
              : null;
            if (text) conversationChapterIndex = { text, hash: hashSessionState(text) };
          } catch (e) {
            dbg('conversation-chapter-index render failed', (e as Error).message);
          }
        }
        // Global user preferences (migration 145) — NOT gated by the project's
        // memory toggle; carried even on minimal windows.
        if (!ignoreMemory && policy.userMemoryChars > 0) {
          try {
            const entries = ctx.bridge?.getUserMemoryIndex?.() ?? null;
            const text = entries ? renderUserMemoryBlock(entries, policy.userMemoryChars) : null;
            if (text) userMemoryIndex = { text, hash: hashSessionState(text) };
          } catch (e) {
            dbg('user-memory render failed', (e as Error).message);
          }
        }
      }
      // Task-preflight hint — fixed for the whole run; the hash only guards
      // double-injection (turn 1 + post-compaction re-inject).
      const preflightText = ignoreMemory ? ctx.opts.preflightHintWithoutMemory : ctx.opts.preflightHint;
      const preflightHint = preflightText
        ? { text: preflightText, hash: hashSessionState(preflightText) }
        : null;
      // Skip computing when nothing fresh AND no recent compaction AND no
      // memory AND no nudge AND no state block worth (re-)injecting.
      if (
        !signals &&
        recentCompactionAt == null &&
        pendingMemory.length === 0 &&
        pendingConversationChapters.length === 0 &&
        !selfReviewNudge &&
        !sessionState &&
        !projectMemoryIndex &&
        !conversationChapterIndex &&
        !userMemoryIndex &&
        !preflightHint &&
        !correctionHint
      )
        return null;
      const result = computeDynamicInjection({
        turn: ctx.turn,
        newlyRegisteredSkillIds: signals?.newlyRegisteredSkillIds ?? [],
        lastInjectedSkillIds: ctx.injectionState.lastInjectedSkillIds,
        // G3 — active skills seen in a PRIOR turn (executedSkillIds holds only
        // prior turns until the commit below) → the post-compaction "don't re-run
        // setup" marker. Empty when none repeat or none were seen before.
        skillsAlreadyExecuted: activeSkillIdsThisTurn.filter((id) =>
          ctx.injectionState.executedSkillIds.has(id),
        ),
        recentlyEditedFiles: signals?.recentlyEditedFiles ?? [],
        lastInjectedFiles: ctx.injectionState.lastInjectedFiles,
        recentCompactionAt,
        relevantMemory: pendingMemory,
        lastInjectedMemoryIds: ctx.injectionState.lastInjectedMemoryIds,
        relevantConversationChapters: pendingConversationChapters,
        lastInjectedConversationChapterIds: ctx.injectionState.lastInjectedConversationChapterIds,
        hasReviewableChanges: selfReviewNudge,
        sessionState,
        sessionStateEveryTurn: policy.stateEveryTurn,
        lastInjectedSessionStateHash: ctx.injectionState.lastInjectedSessionStateHash,
        projectMemoryIndex,
        lastInjectedProjectIndexHash: ctx.injectionState.lastInjectedProjectIndexHash,
        conversationChapterIndex,
        lastInjectedConversationChapterIndexHash:
          ctx.injectionState.lastInjectedConversationChapterIndexHash,
        userMemoryIndex,
        lastInjectedUserMemoryHash: ctx.injectionState.lastInjectedUserMemoryHash,
        preflightHint,
        lastInjectedPreflightHash: ctx.injectionState.lastInjectedPreflightHash,
        correctionHint,
      });
      // Stash for post-assembly commit so we don't double-update state
      // when the same injection is consulted (e.g. by tests).
      if (result) injectionResultForCommit = result;
      return result;
    };
    let reducerStats: { retired: number; freedChars: number; pendingRetired: number; pendingChars: number } | null = null;
    const messagesForChat = assembleMessagesForChat({
      messages: projectVisionContext(ctx.messages, ctx.opts.toolContext.toolOutputStore),
      tunables,
      compactionLimits: undefined,
      agentLoopV2: !!ctx.opts.agentLoopV2,
      buildActiveSkillsBlock: ctx.bridge?.buildActiveSkillsBlock ?? (() => null),
      buildActiveContextBlock: ctx.bridge?.buildActiveContextBlock ?? (() => null),
      computeDynamicInjection: dynamicInjectionFn,
      onReducerStats: (s) => { reducerStats = s; },
    });
    // Commit injection state AFTER assembly succeeds — we now know the
    // skill ids and file paths the reminder included; record them so the
    // next turn's reminder doesn't duplicate them. Also clear the
    // compaction marker after a 2-turn carry window.
    const injectionToCommit = injectionResultForCommit as DynamicInjectionResult | null;
    if (injectionToCommit) {
      for (const id of injectionToCommit.includedSkillIds) {
        ctx.injectionState.lastInjectedSkillIds.add(id);
      }
      for (const f of injectionToCommit.includedFiles) {
        ctx.injectionState.lastInjectedFiles.add(f);
      }
      for (const mid of injectionToCommit.includedMemoryIds) {
        ctx.injectionState.lastInjectedMemoryIds.add(mid);
      }
      if (injectionToCommit.includedMemoryIds.length) {
        try {
          void Promise.resolve(ctx.bridge?.onMemoryInjected?.(injectionToCommit.includedMemoryIds))
            .catch(error => dbg('memory injection receipt failed', String(error)));
        } catch (error) { dbg('memory injection receipt failed', String(error)); }
      }
      for (const chapterId of injectionToCommit.includedConversationChapterIds) {
        ctx.injectionState.lastInjectedConversationChapterIds.add(chapterId);
      }
      if (injectionToCommit.includedSessionStateHash) {
        ctx.injectionState.lastInjectedSessionStateHash = injectionToCommit.includedSessionStateHash;
      }
      if (injectionToCommit.includedProjectIndexHash) {
        ctx.injectionState.lastInjectedProjectIndexHash = injectionToCommit.includedProjectIndexHash;
      }
      if (injectionToCommit.includedConversationChapterIndexHash) {
        ctx.injectionState.lastInjectedConversationChapterIndexHash =
          injectionToCommit.includedConversationChapterIndexHash;
      }
      if (injectionToCommit.includedUserMemoryHash) {
        ctx.injectionState.lastInjectedUserMemoryHash = injectionToCommit.includedUserMemoryHash;
      }
      if (injectionToCommit.includedPreflightHash) {
        ctx.injectionState.lastInjectedPreflightHash = injectionToCommit.includedPreflightHash;
      }
      if (injectionToCommit.includedCorrectionHint && memoryTaskText) {
        nudgeState.lastHash = hashSessionState(memoryTaskText);
        nudgeState.count++;
      }
    }
    // B1/G3 — record this turn's active skills (every turn, independent of the
    // reminder) so a later post-compaction turn knows they were already used.
    for (const id of activeSkillIdsThisTurn) {
      ctx.injectionState.executedSkillIds.add(id);
    }
    if (
      ctx.injectionState.recentCompactionAt != null &&
      ctx.turn - ctx.injectionState.recentCompactionAt > 2
    ) {
      ctx.injectionState.recentCompactionAt = null;
    }

    // P5a — lock the description format on the run's FIRST build so a later
    // tier promotion never rewrites existing descriptions (cache contract:
    // tool shaping must be static or constant-per-run, never per-turn).
    ctx.terseDescriptionsLock ??= (
      ctx.activeTiers !== null &&
      !ctx.activeTiers.has('navigate') &&
      !ctx.activeTiers.has('admin')
    );
    // Perf W1 — memoized catalog build. `buildTools` is a pure function of
    // the key below, which is constant for long stretches of a run, yet the
    // full pipeline (registry scan, tool-filter hook fs read, sort, terse
    // mapping and the eligible-catalog stringify) ran EVERY turn. A key
    // change (new pin, tier promotion, cap change) rebuilds; note the
    // tool-filter hook is therefore only re-read on rebuilds — mid-run hook
    // edits land on the next membership change, which matches the prompt-
    // cache contract of a stable catalog anyway.
    const requiredPinnedToolsForBuild = ctx.opts.requiredPinnedTools
      ? new Set(ctx.opts.requiredPinnedTools)
      : undefined;
    const toolsMemoKey =
      buildToolsCacheKey({
        activeTiers: ctx.activeTiers,
        requiredPinnedTools: requiredPinnedToolsForBuild,
      }) +
      `|cap=${ctx.opts.sessionToolCap ?? ''}` +
      `|terse=${String(ctx.terseDescriptionsLock)}` +
      `|mode=${Boolean(ctx.opts.toolContext.runner?.planMode)}:${Boolean(ctx.opts.toolContext.runner?.specMode)}` +
      `|planRevision=${!!approvedPlanForRevision(ctx.opts.toolContext)}` +
      `|hardLimit=${ctx.opts.provider.toolLimits?.maxCount ?? ''}` +
      `|model=${ctx.opts.provider.model ?? ''}` +
      `|disabled=${JSON.stringify([[...(ctx.opts.globalDisabledTools ?? [])].sort(), [...(ctx.opts.sessionDisabledTools ?? [])].sort()])}`;
    let toolsBuilt: BuildToolsResult;
    if (ctx.toolsMemo && ctx.toolsMemo.key === toolsMemoKey) {
      toolsBuilt = ctx.toolsMemo.built;
    } else {
      toolsBuilt = buildTools({
        stableCatalog: true,
        registry: ctx.opts.registry,
        globalDisabledTools: ctx.opts.globalDisabledTools,
        sessionDisabledTools: ctx.opts.sessionDisabledTools,
        externalToolTiers: ctx.opts.externalToolTiers,
        activeTiers: ctx.activeTiers,
        pinnedTools: ctx.pinnedTools,
        requiredPinnedTools: requiredPinnedToolsForBuild,
        sessionToolCap: ctx.opts.sessionToolCap,
        terseDescriptionsLock: ctx.terseDescriptionsLock,
        toolContext: ctx.opts.toolContext,
        provider: ctx.opts.provider,
        catalogOnlyCapabilities: ctx.opts.catalogOnlyCapabilities,
      });
      ctx.toolsMemo = { key: toolsMemoKey, built: toolsBuilt, variants: new Map() };
    }
    // Recovery is a stable capability. Keeping get_tool_output in the
    // projection before the first spill prevents state-dependent schema churn;
    // an unknown output id is rejected by its handler like any invalid input.
    const toolsVariantKey = 'projection';
    let toolsVariant = ctx.toolsMemo.variants.get(toolsVariantKey);
    if (!toolsVariant) {
      toolsVariant = {
        tools: toolsBuilt.tools,
        json: null,
        fingerprint: null,
        capabilitySetDigest: null,
        projectionDigest: null,
      };
      ctx.toolsMemo.variants.set(toolsVariantKey, toolsVariant);
    }
    const availableTools = toolsVariant.tools;
    let toolsForModel = availableTools;
    // A relevance selection is made once per authorized catalog, not once per
    // turn. New discoveries cannot evict a previously cached tool schema.
    if (ctx.opts.toolSelectionFilter && !toolsVariant.selectionApplied) {
      try {
        const recentUserTexts: string[] = [];
        for (let i = messagesForChat.length - 1; i >= 0; i--) {
          const message = messagesForChat[i];
          if (message.role !== 'user') continue;
          const text = message.content
            .map((block) => block.type === 'text' ? block.text : '')
            .filter(Boolean)
            .join(' ');
          if (text) recentUserTexts.unshift(text);
          if (recentUserTexts.length >= 3) break;
        }
        const taskText = recentUserTexts.join('\n').slice(-4_000);
        const selected = await ctx.opts.toolSelectionFilter(availableTools, {
          taskText,
          recentToolCalls: (ctx.opts.toolContext.toolCallLedger?.snapshot() ?? [])
            .slice(-50)
            .map((entry) => ({
              name: entry.name,
              timestampMs: entry.timestampMs,
              ok: !entry.isError,
            })),
          ...(ctx.opts.sessionId == null
            ? {}
            : { sessionId: ctx.opts.sessionId }),
          protectedToolNames: new Set([
            ...toolsBuilt.protectedToolNames,
            ...ctx.pinnedTools,
          ]),
        });
        if (selected.length > 0) {
          // Selection is relevance-ranked internally, but provider tool order
          // is not a recommendation channel. Keep a stable catalog order so
          // identical memberships retain the same prompt-cache prefix.
          const selectedNames = new Set(selected.map(tool => tool.name));
          // A relevance filter may choose optional tools, never remove a
          // workflow dependency or inject a definition outside this projection.
          toolsForModel = availableTools.filter(tool => selectedNames.has(tool.name)
            || toolsBuilt.protectedToolNames.has(tool.name));
        }
      } catch (e) {
        console.warn(`[coder] tool-selection failed: ${e instanceof Error ? e.message : String(e)}`);
      }
      toolsVariant.tools = toolsForModel;
      toolsVariant.selectionApplied = true;
    }
    const rejectedSchemas = rejectedProviderTools(ctx);
    if (rejectedSchemas.size) toolsForModel = toolsForModel.filter(tool => !rejectedSchemas.has(tool.name));
    let capabilitySetDigest: string | null = null;
    let projectionDigest: string | null = null;
    try {
      if (toolsForModel === toolsVariant.tools
        && toolsVariant.capabilitySetDigest
        && toolsVariant.projectionDigest) {
        capabilitySetDigest = toolsVariant.capabilitySetDigest;
        projectionDigest = toolsVariant.projectionDigest;
      } else {
        const resolved = resolveProviderCapabilityProjection(
          toolsBuilt.authorizedTools,
          toolsForModel,
          { agentRunId: ctx.runId as AgentRunId },
        );
        capabilitySetDigest = resolved.set.hash;
        projectionDigest = resolved.projection.digest;
        if (toolsForModel === toolsVariant.tools) {
          toolsVariant.capabilitySetDigest = capabilitySetDigest;
          toolsVariant.projectionDigest = projectionDigest;
        }
      }
    } catch (error) {
      // A provider projection outside the authorized attempt set is an
      // execution-authority failure, not best-effort telemetry.
      throw new Error(
        `provider capability projection failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const effectiveToolNames = new Set(toolsForModel.map((tool) => tool.name));
    const authorizedToolNames = new Set(toolsBuilt.authorizedTools.map(tool => tool.name));
    const runnerToolState = ctx.opts.toolContext.runner as
      | {
          visibleToolNames?: ReadonlySet<string> | null;
          authorizedToolNames?: ReadonlySet<string> | null;
          promoteTool?: (name: string) => string[];
          requestedToolNames?: ReadonlySet<string>;
          projectionReceipt?: import('../../tool-projection.js').ToolProjectionReceipt | null;
        }
      | undefined;
    if (runnerToolState) runnerToolState.authorizedToolNames = authorizedToolNames;
    dbg(`tools=${toolsForModel.length} tiers=${ctx.activeTiers === null ? '*' : Array.from(ctx.activeTiers).join(',')}`);

    const systemPrompt = ctx.opts.systemPrompt + outcomeRecoveryPrompt(ctx.opts.toolContext.outcomeRecovery,
      ctx.opts.toolContext.permissionGate?.getMode?.() ?? ctx.opts.toolPermissionMode ?? 'auto')
      + toolSchemaRecoveryPrompt(ctx);

    // PR-F pre-emit gate (Kimi-style). Estimate the size of the request
    // we're about to make BEFORE actually sending it. If projected to
    // exceed 90% of the effective window, route through Compacting first
    // — saves the cost of an oversized request that the provider would
    // either reject or chew through expensive cache-busts.
    //
    // Skipped on turn 1 (no body yet) and when usage is unknown
    // (first turns before the provider reports tokens). The `messages`
    // length guard inside `shouldCompactPreEmit` covers the first case;
    // we cover the unknown-usage case implicitly because the estimate
    // works from `messagesForChat` alone, not from a provider count.
    const prefixTokensEstimate = computePrefixTokens(systemPrompt, toolsForModel);
    const preEmit = shouldCompactPreEmit({
      messages: messagesForChat,
      // No pending tool_results at this point in the loop — the model
      // hasn't emitted the next tool batch yet. Just messages + prefix.
      prefixTokens: prefixTokensEstimate,
      model: ctx.opts.provider.model,
      contextWindow: ctx.opts.contextWindow,
      // EMA-learned real/estimate ratio — keeps a drifting chars/4 estimate
      // from compacting prematurely (or never) before the provider call.
      calibration: ctx.estimateCalibration ?? 1,
    });
    // P2 — irreducible-context bypass. The Compacting node may already have
    // PROVEN (via consecutive no-ops) that there's no compactable head: a
    // single recent message (typically a large tool_result) exceeds the
    // protected tail, so summarizing the head can never bring the projection
    // down. Routing into Compacting again just burns passes until the
    // `compact_exhausted` abort below — killing a run whose request is still
    // WITHIN the hard window (the 0.90 gate is a safety margin, not a ceiling;
    // `effective` already reserves output room). Mirror the post-turn
    // suppression gate: when irreducible AND the projection still fits the
    // effective window, send the request as-is instead of looping/aborting.
    const preEmitIrreducible =
      preEmit.shouldCompact &&
      ctx.consecutiveNoopCompactions >= 2 &&
      preEmit.projectedTokens <= preEmit.effective;
    if (preEmit.shouldCompact && !preEmitIrreducible) {
      // The decrement below means `maxTurns` can't backstop a pre-emit
      // compaction that keeps firing without ever freeing the window
      // (e.g. the protected tail alone exceeds 90%, or a huge tool_result
      // sits in the protected zone). Bound the consecutive cycles
      // explicitly: after `cap` passes in a row the context is
      // irreducible — abort cleanly rather than loop forever.
      ctx.preEmitCompactions += 1;
      const cap = 3;
      if (ctx.preEmitCompactions > cap) {
        ctx.stopReason = 'compact_exhausted';
        ctx.error = new Error(
          `pre-emit compaction failed to free the context window after ${cap} ` +
          `consecutive passes (projected=${preEmit.projectedTokens} ` +
          `effective=${preEmit.effective} ratio=${preEmit.ratio.toFixed(3)})`,
        );
        dbg(`pre-emit cap exceeded (${ctx.preEmitCompactions}/${cap}) — aborting compact_exhausted`);
        return events.aborted();
      }
      dbg(
        `pre-emit gate fired (${ctx.preEmitCompactions}/${cap}): projected=${preEmit.projectedTokens} ` +
        `effective=${preEmit.effective} ratio=${preEmit.ratio.toFixed(3)}`,
      );
      // We bumped ctx.turn at the top of execute(), but the provider was
      // never called. Decrement so the next Executing entry (after
      // Compacting) counts as the same logical turn — avoids burning the
      // auto-continue budget on compactions.
      ctx.turn = Math.max(0, ctx.turn - 1);
      return events.tokenThresholdHit({ ratio: preEmit.ratio });
    }
    if (preEmitIrreducible) {
      dbg(
        `pre-emit suppressed — context irreducible after ` +
        `${ctx.consecutiveNoopCompactions} no-op pass(es): sending as-is ` +
        `(projected=${preEmit.projectedTokens} effective=${preEmit.effective} ` +
        `ratio=${preEmit.ratio.toFixed(3)})`,
      );
    }
    // Gate passed (or suppressed as irreducible) — any prior compaction freed
    // enough room, so reset the consecutive-pre-emit counter. A future runaway
    // starts counting fresh.
    ctx.preEmitCompactions = 0;

    const tempResolution = ctx.bridge?.resolveTemperature?.();
    const prevResponse = ctx.bridge?.getPreviousResponseId?.();

    // Dashboard telemetry — fires BEFORE the network call so the UI can
    // show "calling provider…" with the resolved tool count + payload size.
    const historyChars = ctx.messages.reduce(
      (acc, m) => acc + JSON.stringify(m.content).length,
      0,
    );
    ctx.emit('provider_call', {
      runId: ctx.runId,
      turn: ctx.turn,
      provider: ctx.opts.provider.name,
      model: ctx.opts.provider.model,
      toolCount: toolsForModel.length,
      historyChars,
      timing: {
        preparation_ms: Math.round(performance.now() - preparationStartedAt),
        persistence_wait_ms: Math.round(persistence.waitMs),
      },
    });

    const providerOpId = `provider-chat:${ctx.runId}:${ctx.turn}`;
    let providerOpFinished = false;
    ctx.operations.start({
      opId: providerOpId,
      kind: 'provider',
      label: `${ctx.opts.provider.name}:${ctx.opts.provider.model}`,
      phase: 'starting',
    });

    // Vision fallback — when the active model can't see images (or the composer
    // "Describe images" flag forces it), swap image blocks for agent-directed
    // text descriptions BEFORE the call. Runs on a copy; history keeps the raw
    // image. `=== false` is strict so unknown capability never pays the cost.
    const visionGate = !!ctx.opts.describeImages || ctx.opts.modelSupportsVision === false;
    const chatMessages = visionGate
      ? await applyVisionFallback({
          messages: messagesForChat,
          gate: visionGate,
          describer: getGlobalVisionDescriber(),
          signal: ctx.opts.toolContext.signal,
        })
      : messagesForChat;

    const providerLifecycleStartedAt = Date.now();
    let providerLifecycleOutcome: {
      ok: boolean;
      status: 'completed' | 'failed' | 'aborted';
      inputTokens?: number;
      outputTokens?: number;
      errorType?: string;
    } = { ok: false, status: 'failed' };
    if (ctx.opts.hookBus) {
      try {
        await ctx.opts.hookBus.fireObservation('before_provider_call', {
          runId: ctx.runId,
          sessionId: ctx.opts.sessionId ?? null,
          turn: ctx.turn,
          provider: ctx.opts.provider.name,
          model: ctx.opts.provider.model,
          messageCount: chatMessages.length,
          toolCount: toolsForModel.length,
        });
      } catch {
        // Observation only.
      }
    }

    let reportedProviderAttempts = 0;
    const recordProviderAttempt = (attempt: ProviderAttemptTelemetry): void => {
      reportedProviderAttempts += 1;
      const providerAttempt = ++ctx.providerAttempts;
      const usageForEstimate =
        attempt.inputTokens != null || attempt.outputTokens != null
          ? {
              input_tokens: attempt.inputTokens ?? 0,
              output_tokens: attempt.outputTokens ?? 0,
              prompt_tokens_total: attempt.inputTokens ?? 0,
              cache_read_input_tokens: attempt.cachedTokens ?? 0,
            }
          : null;
      const estimatedCost = usageForEstimate
        ? estimateCost(
            ctx.opts.provider.name,
            ctx.opts.provider.model,
            usageForEstimate,
          )
        : 0;
      const persistAttempt = ctx.opts.sessionStore?.recordProviderAttempt({
        session_id: ctx.opts.sessionId ?? null,
        run_id: ctx.runId,
        turn: ctx.turn,
        attempt: providerAttempt,
        provider: ctx.opts.provider.name,
        model: ctx.opts.provider.model,
        status: attempt.status,
        ok: attempt.ok,
        generation_id: attempt.generationId ?? null,
        request_id: attempt.requestId ?? null,
        upstream_provider: attempt.upstreamProvider ?? null,
        input_tokens: attempt.inputTokens ?? null,
        output_tokens: attempt.outputTokens ?? null,
        cached_tokens: attempt.cachedTokens ?? null,
        cost_usd:
          attempt.costUsd != null
            ? attempt.costUsd
            : estimatedCost > 0
              ? estimatedCost
              : null,
        retry_after: attempt.retryAfter ?? null,
        error_code: attempt.errorCode ?? null,
        error_message: attempt.errorMessage ?? null,
        duration_ms: attempt.durationMs,
      });
      void Promise.resolve(persistAttempt).catch((error) => {
        dbg(
          'provider attempt metric persistence failed',
          error instanceof Error ? error.message : String(error),
        );
      });
    };
    let result!: Awaited<ReturnType<typeof consumeStream>>;
    // One transport scope per physical provider turn. A timeout cancels the
    // old HTTP stream before recovery may try another provider request.
    const providerRequest = new AbortController();
    let lastTransportActivityAt: number | undefined;
    const parentSignal = ctx.opts.toolContext.signal;
    const relayProviderAbort = () => providerRequest.abort(parentSignal?.reason);
    const relayPersistenceFailure = () => providerRequest.abort(persistence.failureSignal.reason);
    persistence.failureSignal.addEventListener('abort', relayPersistenceFailure, { once: true });
    if (persistence.failureSignal.aborted) relayPersistenceFailure();
    parentSignal?.addEventListener?.('abort', relayProviderAbort, { once: true });
    if (parentSignal?.aborted) relayProviderAbort();
    try {
    let stream: AsyncIterable<ChatDelta>;
    try {
      dbg(`calling provider.chat() model=${ctx.opts.provider.model}`);
      const verifiedLimits = ctx.opts.provider.toolLimits;
      if (verifiedLimits?.maxCount !== undefined && toolsForModel.length > verifiedLimits.maxCount) throw new Error('Final tool projection exceeds the verified provider limit');
      if (verifiedLimits?.maxSchemaBytes !== undefined && Buffer.byteLength(JSON.stringify(toolsForModel)) > verifiedLimits.maxSchemaBytes) throw new Error('Final tool projection exceeds the verified provider schema byte limit');
      if (verifiedLimits?.maxNameChars !== undefined && toolsForModel.some(tool => tool.name.length > verifiedLimits.maxNameChars!)) throw new Error('Final tool projection exceeds the verified provider function name limit');
      if (runnerToolState) {
        runnerToolState.visibleToolNames = effectiveToolNames;
        runnerToolState.projectionReceipt = toolProjectionReceipt(runnerToolState.requestedToolNames ?? [], effectiveToolNames,
          new Set(toolsBuilt.authorizedTools.map(t => t.name)), projectionDigest, capabilitySetDigest, rejectedSchemas);
      }
      ctx.lastProviderToolNames = effectiveToolNames;
      ctx.operations.progress(providerOpId, { phase: 'provider.chat' });
      stream = ctx.opts.provider.chat({
        system: systemPrompt,
        messages: chatMessages,
        tools: toolsForModel,
        thinking: ctx.opts.thinking,
        thinkingBudgetTokens: ctx.opts.thinkingBudgetTokens,
        ...(ctx.opts.reasoningEffort
          ? { reasoningEffort: ctx.opts.reasoningEffort }
          : {}),
        sessionId: ctx.opts.sessionId,
        onAttempt: recordProviderAttempt,
        onTransportActivity: () => { lastTransportActivityAt = performance.now(); },
        signal: providerRequest.signal,
        ...(tempResolution && typeof tempResolution.temperature === 'number'
          ? { inference: { temperature: tempResolution.temperature } }
          : {}),
        ...(prevResponse
          ? {
              previousResponseId: prevResponse.id,
              previousResponseMessageCount: prevResponse.messageCount,
            }
          : {}),
      });
    } catch (e) {
      dbg('provider.chat() threw', e);
      if (reportedProviderAttempts === 0) {
        const attemptError = fallbackAttemptErrorMeta(e, 'provider_chat_threw');
        recordProviderAttempt({
          status: attemptError.status,
          ok: false,
          requestId: attemptError.requestId,
          retryAfter: attemptError.retryAfter,
          errorCode: attemptError.errorCode,
          errorMessage: attemptError.errorMessage,
          durationMs: Date.now() - providerLifecycleStartedAt,
        });
      }
      providerLifecycleOutcome = {
        ok: false,
        status: isAbortError(e) ? 'aborted' : 'failed',
        errorType: e instanceof Error ? e.name : 'UnknownError',
      };
      providerOpFinished = true;
      ctx.operations.finish(providerOpId, 'failed', {
        phase: 'provider.chat',
        note: e instanceof Error ? e.message : String(e),
      });
      return providerErrorEvent(e);
    }

    // Camada 3 — heartbeat around `provider.chat()` so the dashboard
    // StuckBanner doesn't trip while the model is slow to start emitting
    // deltas (GLM-5 with large tools+system prompt routinely takes 30-90s
    // before the first text_delta). Cleared in finally regardless of how
    // consumeStream resolves. Default 10s; env-tunable.
    const STREAM_HEARTBEAT_MS = ctx.opts.runtimePolicy?.provider.streamHeartbeatMs ?? 10_000;
    const streamStartedAt = Date.now();
    // How much THIS attempt streamed. Only meaningful if it dies mid-stream:
    // the partial output never reaches `assistantContent`, so consumers have to
    // retract exactly this much before the retry streams its replacement.
    let attemptTextChars = 0;
    let attemptThinkingChars = 0;
    const streamHeartbeat = setInterval(() => {
      const snapshot = ctx.operations.heartbeat(providerOpId, {
        phase: 'streaming',
        note: `awaiting ${ctx.opts.provider.name}:${ctx.opts.provider.model}`,
      });
      ctx.emit('tool_progress', {
        id: providerOpId,
        name: 'provider.chat',
        elapsedMs: Date.now() - streamStartedAt,
        note: `awaiting ${ctx.opts.provider.name}:${ctx.opts.provider.model}…`,
        kind: 'heartbeat',
        ...(snapshot ? { idleMs: snapshot.idleMs } : {}),
      });
    }, STREAM_HEARTBEAT_MS);

    try {
      result = await consumeStream({
        stream,
        signal: providerRequest.signal,
        cancelStream: (reason) => providerRequest.abort(reason),
        lastTransportActivityAt: () => lastTransportActivityAt,
        onTextDelta: (text, meta) => {
          // Keep operation liveness accurate without mirroring every token as
          // a second `operation_progress` event. The 10s stream heartbeat
          // above remains the sampled progress signal for diagnostics/UI.
          ctx.operations.touch(providerOpId, { phase: 'text_delta' });
          attemptTextChars += text.length;
          ctx.emit('text_delta', text, meta);
        },
        onThinkingDelta: (text) => {
          ctx.operations.touch(providerOpId, { phase: 'thinking_delta' });
          attemptThinkingChars += text.length;
          ctx.emit('thinking_delta', text);
        },
      });
    } catch (e) {
      dbg('consumeStream threw', e);
      if (reportedProviderAttempts === 0) {
        const attemptError = fallbackAttemptErrorMeta(
          e,
          isAbortError(e) ? 'aborted' : 'provider_stream_failed',
        );
        recordProviderAttempt({
          status: attemptError.status,
          ok: false,
          requestId: attemptError.requestId,
          retryAfter: attemptError.retryAfter,
          errorCode: attemptError.errorCode,
          errorMessage: attemptError.errorMessage,
          durationMs: Date.now() - providerLifecycleStartedAt,
        });
      }
      providerLifecycleOutcome = {
        ok: false,
        status: isAbortError(e) ? 'aborted' : 'failed',
        errorType: e instanceof Error ? e.name : 'UnknownError',
      };
      providerOpFinished = true;
      if (isAbortError(e)) {
        ctx.operations.finish(providerOpId, 'aborted', { phase: 'aborted', note: 'user/session aborted' });
        ctx.aborted = true;
        ctx.stopReason = 'aborted';
        return events.aborted();
      }
      ctx.operations.finish(providerOpId, 'failed', {
        phase: 'streaming',
        note: e instanceof Error ? e.message : String(e),
      });
      // Retract this attempt's partial output before Recovering re-enters
      // Executing. Nothing here was persisted, and the retry re-reasons from
      // the same transcript — without the retraction the discarded attempt
      // stays on screen and its near-identical replacement renders underneath.
      // Deliberately NOT done on the abort path above: the user stopped the
      // run and the partial answer is what they stopped to read.
      if (attemptTextChars > 0 || attemptThinkingChars > 0) {
        ctx.emit('stream_rollback', {
          textChars: attemptTextChars,
          thinkingChars: attemptThinkingChars,
          reason: e instanceof Error ? e.name : 'UnknownError',
        });
      }
      return providerErrorEvent(e);
    } finally {
      clearInterval(streamHeartbeat);
      if (!providerOpFinished) {
        providerOpFinished = true;
        ctx.operations.finish(providerOpId, 'completed', { phase: 'completed' });
      }
    }
    if (reportedProviderAttempts === 0) {
      const response = result.responseMeta?.response;
      recordProviderAttempt({
        // An adapter that does not expose `onAttempt` may own retries itself.
        // Record only response facts it actually surfaced; never manufacture a
        // physical HTTP 200 from iterator completion alone.
        status: typeof response?.status === 'number' ? response.status : null,
        ok: response?.ok !== false,
        generationId: result.responseId,
        requestId: response?.request_id ?? null,
        inputTokens: result.usage?.input_tokens ?? null,
        outputTokens: result.usage?.output_tokens ?? null,
        cachedTokens: result.usage?.cache_read_input_tokens ?? null,
        retryAfter: response?.retry_after ?? null,
        durationMs: Date.now() - providerLifecycleStartedAt,
      });
    }
    providerLifecycleOutcome = {
      ok: true,
      status: 'completed',
      inputTokens: result.usage?.input_tokens,
      outputTokens: result.usage?.output_tokens,
    };
    } finally {
      parentSignal?.removeEventListener?.('abort', relayProviderAbort);
      persistence.failureSignal.removeEventListener('abort', relayPersistenceFailure);
      providerRequest.abort();
      if (ctx.opts.hookBus) {
        try {
          await ctx.opts.hookBus.fireObservation('after_provider_call', {
            runId: ctx.runId,
            sessionId: ctx.opts.sessionId ?? null,
            turn: ctx.turn,
            provider: ctx.opts.provider.name,
            model: ctx.opts.provider.model,
            durationMs: Date.now() - providerLifecycleStartedAt,
            ...providerLifecycleOutcome,
          });
        } catch {
          // Observation only.
        }
      }
    }
    dbg(`stream done text=${result.textBlocks.length}b tools=${result.toolUses.length} usage_in=${result.usage?.input_tokens ?? '?'}`);

    accumulateUsage(ctx, result.usage);
    // A successful provider response ends the retry sequence for this logical
    // call, regardless of whether the model now requests tools.
    resetProviderRetrySequence(ctx);

    if (result.responseId !== null && result.responseMessageCount !== null) {
      ctx.bridge?.onResponseId?.(result.responseId, result.responseMessageCount);
    }

    // Telemetry persistence helper — invoked from BOTH the text-only path
    // (no tool_uses) and the tool-dispatch path. The pure function lives
    // in `core/runner/telemetry/persist-turn.ts`; the bridge wrapper in
    // `runner.ts` adds the tool-selection feedback observer and updates
    // `runner.lastTurnTelemetryId` so the host's `flushPendingTurn` can
    // stamp pending tool calls.
    //
    // `summarizerRan` is always false at this point — Compacting is the
    // node that toggles it, and it fires AFTER Executing returns. The
    // legacy passed `true` when the per-turn pre-compaction ran; in the
    // BT, that flag is recorded on the NEXT turn's row instead, after
    // the host emits `turn_start` post-Compacting. Acceptable trade-off
    // — the metric stays consistent within a session, just shifted by
    // one row.
    const { toolsDefChars, toolsFingerprint } = (() => {
      try {
        // Perf W1 — when the model got the memoized catalog verbatim (no
        // relevance selection this turn), serialize/fingerprint ONCE and
        // cache on the variant; the ~50-105k-char stringify was previously
        // paid every turn. Selection-filtered catalogs still stringify.
        if (toolsForModel === toolsVariant.tools) {
          toolsVariant.json ??= JSON.stringify(toolsForModel);
          toolsVariant.fingerprint ??= fingerprintToolsJson(toolsVariant.json);
          return {
            toolsDefChars: toolsVariant.json.length,
            toolsFingerprint: toolsVariant.fingerprint,
          };
        }
        const json = JSON.stringify(toolsForModel);
        return { toolsDefChars: json.length, toolsFingerprint: fingerprintToolsJson(json) };
      } catch {
        return { toolsDefChars: 0, toolsFingerprint: null };
      }
    })();
    const prefixHeadHash = computePrefixHeadHash(messagesForChat);
    const runPersistTelemetry = (toolResultBlocks: ReadonlyArray<ContentBlock>): void => {
      if (!ctx.bridge?.persistTurnTelemetry) return;
      try {
        const id = ctx.bridge.persistTurnTelemetry({
          turn: ctx.turn,
          autoContinues: ctx.autoContinues,
          usage: result.usage,
          toolUseBlocks: result.toolUses.map((t) => ({
            type: 'tool_use' as const,
            id: t.id,
            name: t.name,
            input: t.input,
          })),
          toolResultBlocks,
          historyChars,
          systemPromptChars: systemPrompt.length,
          toolsDefChars,
          eligibleToolsDefChars: toolsBuilt.eligibleToolsDefChars,
          visibleToolsCount: toolsForModel.length,
          toolsFingerprint,
          capabilitySetDigest,
          projectionDigest,
          prefixHeadHash,
          reducerStats,
          responseMeta: result.responseMeta,
          // Compaction never fires INSIDE Executing — the Token-Threshold
          // event we may emit below is the SIGNAL to the orchestrator to
          // transition to Compacting on the NEXT cycle.
          compactionTriggered: false,
          summarizerRan: false,
        });
        // Perf W1 — async writer path returns a promise; the id lands when
        // the off-thread insert settles (before the host's flush stamps tool
        // calls — it awaits runner.lastTurnTelemetryIdPromise).
        if (id && typeof id === 'object') {
          void id.then((resolved) => { ctx.lastTurnTelemetryId = resolved; });
        } else {
          ctx.lastTurnTelemetryId = id;
        }
      } catch {
        // Telemetry failures NEVER break the turn.
      }
    };

    await persistence.wait();
    if (result.responseMeta?.timing) {
      result.responseMeta.timing.persistence_duration_ms = persistence.durationMs;
      result.responseMeta.timing.persistence_wait_ms = persistence.waitMs;
    }
    // Block order MUST be: thinking → text → tool_use. The provider rejects
    // (Anthropic 400) when extended-thinking content arrives after text or
    // tool_use in the SAME assistant message — preserve the legacy order.
    const assistantContent: ContentBlock[] = [];
    for (const t of result.thinkingBlocks) {
      if (t) assistantContent.push({ type: 'thinking', text: t });
    }
    for (const text of result.textBlocks) {
      if (text) assistantContent.push({ type: 'text', text });
    }
    assistantContent.push(...result.generatedImages);
    for (const tu of result.toolUses) {
      assistantContent.push({ type: 'tool_use', id: tu.id, name: tu.name, input: tu.input });
    }
    // ── Honest context accounting (single source of truth) ──────────────
    // True prompt size of the call we just made: adapter-normalized usage
    // (`prompt_tokens_total` — includes cached slices on Anthropic-style
    // APIs) or the tokenizer estimate, EMA-calibrated against real usage so
    // usage-less providers don't trip the gates on chars/4 noise. Drives the
    // compaction gates below AND the `context_status` event the dashboard
    // context bar renders — one number, no live-vs-persisted jumps.
    const estPromptTokens = estimateMessagesTokens(messagesForChat) + prefixTokensEstimate;
    const realPromptTokens = promptTokensTotal(result.usage);
    if (realPromptTokens != null && estPromptTokens > 0) {
      const sample = Math.min(3, Math.max(1 / 3, realPromptTokens / estPromptTokens));
      ctx.estimateCalibration =
        ctx.estimateCalibration == null ? sample : ctx.estimateCalibration * 0.7 + sample * 0.3;
    }
    const promptTokens =
      realPromptTokens ?? Math.round(estPromptTokens * (ctx.estimateCalibration ?? 1));
    const usageSource: 'usage' | 'estimate' = realPromptTokens != null ? 'usage' : 'estimate';
    const limits = deriveTokenLimits(ctx.opts.provider.model, ctx.opts.contextWindow);
    const context = { prompt_tokens: promptTokens, source: usageSource, context_window: limits.effective };
    if (assistantContent.length > 0) {
      const assistantMessage = {
        role: 'assistant' as const,
        content: assistantContent,
        phase: result.messagePhase,
      };
      if (result.providerReplay) bindProviderReplay(assistantMessage, result.providerReplay);
      ctx.messages.push(assistantMessage);
      ctx.emit('message_complete', assistantMessage, result.usage, `assistant:${ctx.runId}:message:${ctx.turn}`, context);
    }
    ctx.emit('context_status', { ...context, turn: ctx.turn, ratio: promptTokens / limits.effective });

    // Dashboard telemetry — preview the batch before dispatch so the UI
    // can render the pending tool list immediately (legacy parity).
    ctx.emit('tool_batch', {
      runId: ctx.runId,
      turn: ctx.turn,
      count: result.toolUses.length,
      names: result.toolUses.map((t) => t.name),
    });

    if (result.toolUses.length === 0) {
      // Mandatory-plan gate: in plan mode the deliverable IS a plan. If the
      // model tries to end with bare text (no submit_plan/submit_tasks, no
      // approval), inject a ONE-SHOT reminder as the next user message and
      // re-enter the turn instead of finishing. Bounded at one nudge so a
      // genuinely conversational reply still terminates. See executing-plan-gate.
      const planNudge = maybePlanNudge(ctx);
      if (planNudge) {
        runPersistTelemetry([]);
        ctx.messages.push({ role: 'user', content: [{ type: 'text', text: planNudge }] });
        return events.turnSucceeded({ hasToolCalls: false });
      }
      // A successful current-run write needs one chance to collect objective
      // validation before a text-only finish. This is deliberately bounded to
      // one short nudge: agents can still finish by accurately reporting why
      // validation was unavailable, but cannot silently claim it already ran.
      if (ctx.opts.verificationEvidenceEnabled) {
        const readiness = await evaluateVerificationReadinessAtFinish(ctx);
        const verificationNudge = maybeVerificationNudge(ctx, readiness);
        if (verificationNudge) {
          runPersistTelemetry([]);
          ctx.messages.push({
            role: 'user',
            content: [{ type: 'text', text: verificationNudge }],
          });
          return events.turnSucceeded({ hasToolCalls: false });
        }
      }
      // Text-only assistant turn ends the run — no tool_use means the model is
      // delivering its final reply.
      runPersistTelemetry([]);
      // Telemetry accuracy: if plan mode is active and no plan was ever
      // approved (the one-shot nudge was already spent), the run finished
      // WITHOUT delivering a plan — flag it as 'plan_required' rather than a
      // clean 'completed' so monitoring can distinguish the two.
      ctx.stopReason =
        ctx.opts.planMode && ctx.bridge?.isPlanApproved?.() === false
          ? 'plan_required'
          : 'completed';
      return events.cleanFinish();
    }

    const requiredPinnedTools = ctx.opts.requiredPinnedTools
      ? new Set(ctx.opts.requiredPinnedTools)
      : undefined;
    // A call to an already-promoted tool is a recency signal. Reordering the
    // Set does not change the memo key; it affects only which old pin leaves
    // when a genuinely new capability is promoted later.
    for (const toolUse of result.toolUses) {
      touchDynamicToolPin(ctx.pinnedTools, requiredPinnedTools, toolUse.name);
    }
    // Refused calls never fired tool_call_start, so the telemetry listener in
    // index.ts has no pending entry to read args from — carry the original
    // input on the result event itself (along with the refusal kind).
    const inputByUseId = new Map(result.toolUses.map((t) => [t.id, t.input]));
    const publishToolResult = (r: DispatchedToolResult): void => {
      ctx.operations.finish(`tool:${r.toolUseId}`, r.isError ? 'failed' : 'completed', {
        phase: r.isError ? 'failed' : 'completed',
      });
      // Surface a tool image (e.g. preview_screenshot / view_image) in the
      // result so the dashboard shows it inline under the tool call — the
      // same image the model receives via the synthetic user message above.
      const img = r.extraUserBlocks?.find(
        (b): b is { type: 'image'; mediaType: string; base64: string } =>
          (b as { type?: string }).type === 'image',
      );
      // Diagnostic (terminal-visible): confirms the worker is emitting the
      // image on tool_call_result. If you see this line but no image in the
      // chat, the gap is dashboard-side; if absent, the worker build is stale.
      if (img) {
        try { console.error(`[preview-img] emit ${r.name} ${img.base64?.length ?? 0}b`); } catch { /* noop */ }
      }
      ctx.emit(
        'tool_call_result',
        r.toolUseId,
        r.name,
        {
          content: r.content,
          evidence: r.evidence,
          structuredData: r.structuredData,
          structuredDataOmitted: r.structuredDataOmitted,
          isError: r.isError,
          effectOutcome: r.effectOutcome,
          rawChars: r.rawChars,
          contentFormat: r.contentFormat,
          structuredOutputChars: r.structuredOutputChars,
          input: inputByUseId.get(r.toolUseId),
          refusalKind: r.refusalKind,
          reductionReport: r.reductionReport,
          sourceTruncations: r.sourceTruncations,
          truncated: r.truncated,
          outputId: r.outputId,
          ledgerEntry: r.ledgerEntry,
          guardVerdict: r.guardVerdict,
          stateEpoch: r.stateEpoch,
          ...(img ? { image: { mediaType: img.mediaType, base64: img.base64 } } : {}),
        },
        r.durationMs,
      );
    };

    const dispatch = await dispatchTools({
      onToolResult: publishToolResult,
      toolUses: result.toolUses,
      retrievalBatch: { taskText: memoryTaskText ?? undefined },
      registry: ctx.opts.registry,
      // RAW invocations retain this branch even if recovery advances the host.
      toolContext: { ...ctx.opts.toolContext },
      turn: ctx.turn,
      dupCalls: ctx.dupCalls,
      noProgressTracker: ctx.noProgressTracker,
      // Pin mechanism — hidden registered tools execute and join the
      // visible list next turn; disabled tools hard-block at dispatch.
      visibleToolNames: effectiveToolNames,
      pinnedTools: ctx.pinnedTools,
      onToolPinned: (name) => {
        if (runnerToolState?.promoteTool) {
          runnerToolState.promoteTool(name);
          return;
        }
        const evicted = promoteDynamicToolPin(
          ctx.pinnedTools,
          requiredPinnedTools,
          name,
        );
        if (evicted.length > 0) {
          console.log(
            `[coder] dynamic tool window: promoted ${name}; evicted LRU ${evicted.join(', ')}`,
          );
        }
      },
      isToolBlocked: (name) => {
        if (!authorizedToolNames.has(name)) {
          return `[tool-disabled] '${name}' is outside the authorized attempt catalog.`;
        }
        if (ctx.opts.globalDisabledTools?.has(name)) {
          return `[tool-disabled] '${name}' is disabled globally by the admin — pick another tool (find_tools lists alternatives).`;
        }
        if (ctx.opts.sessionDisabledTools?.has(name)) {
          return `[tool-disabled] '${name}' is disabled for this session — pick another tool (find_tools lists alternatives).`;
        }

        return null;
      },
      toolGate: async (name, input) => {
        const bridgeRefusal = ctx.bridge?.toolGate?.(name, input);
        if (bridgeRefusal != null) return bridgeRefusal;
        return null;
      },
      enforcePreRead: ctx.bridge?.enforcePreRead,
      enforceTaskMode: ctx.bridge?.enforceTaskMode,
      // Fase 2.5 — Policy Engine shadow port (absent by default).
      policyShadow: ctx.opts.policyShadow,
      ...(ctx.opts.hookBus
        ? {
            capabilityHooks: {
              before: (input: {
                toolUseId: string;
                toolName: string;
                turn: number;
                known: boolean;
              }) => ctx.opts.hookBus!.fireObservation('before_capability', {
                runId: ctx.runId,
                sessionId: ctx.opts.sessionId ?? null,
                ...input,
              }).then(() => undefined),
              after: (input: {
                toolUseId: string;
                toolName: string;
                turn: number;
                known: boolean;
                isError: boolean;
                refused: boolean;
                durationMs: number;
              }) => ctx.opts.hookBus!.fireObservation('after_capability', {
                runId: ctx.runId,
                sessionId: ctx.opts.sessionId ?? null,
                ...input,
              }).then(() => undefined),
            },
          }
        : {}),
      registerInFlightTool: ctx.bridge?.registerInFlightTool,
      unregisterInFlightTool: ctx.bridge?.unregisterInFlightTool,
      consumeInjectedToolError: ctx.bridge?.consumeInjectedToolError,
      reduceToolResult: ctx.bridge?.reduceToolResult,
      finalizeToolResult: ctx.bridge?.finalizeToolResult,
      postProcessToolResult: async (args) => {
        let content = args.content;
        let isError = args.isError;
        const bridged = await ctx.bridge?.postProcessToolResult?.(args);
        if (bridged) {
          content = bridged.content;
          isError = bridged.isError ?? isError;
        }

        return bridged ? { content, isError } : null;
      },
      detectPollingStuck: ctx.bridge?.detectPollingStuck,
      collectBackgroundNotices: () => drainBackgroundNotices(ctx.opts.toolContext),
      onToolCallStart: (id, name, input) => {
        ctx.operations.start({
          opId: `tool:${id}`,
          kind: 'tool',
          label: name,
          phase: 'running',
        });
        ctx.emit('tool_call_start', id, name, input);
      },
      onToolCallFinalized: (id, shapedChars) =>
        ctx.emit('tool_call_finalized', id, { shapedChars }),
      onToolProgress: (id, name, elapsedMs, note, kind = 'heartbeat') => {
        const snapshot = kind === 'progress'
          ? ctx.operations.progress(`tool:${id}`, { phase: 'running', ...(note ? { note } : {}) })
          : ctx.operations.heartbeat(`tool:${id}`, { phase: 'running', ...(note ? { note } : {}) });
        ctx.emit('tool_progress', {
          id,
          name,
          elapsedMs,
          ...(note ? { note } : {}),
          kind,
          ...(snapshot ? { idleMs: snapshot.idleMs } : {}),
        });
      },
      // Nested-call guards (code_exec): one observer per parent. Invocation
      // dedup is local to that observer; only result-aware failure/no-progress
      // state is shared with the run. The telemetry sink emits
      // `nested_tool_call` for the per-call audit trail.
      makeNestedObserver: (parentToolUseId, parentToolName) => {
        if (parentToolName !== 'code_exec' || !nestedGuardsEnabled()) return undefined;
        return buildNestedToolObserver({
          dupCalls: ctx.dupCalls,
          failureStreaks: ctx.failureStreaks,
          noProgressTracker: ctx.noProgressTracker,
          toolCallLedger: ctx.opts.toolContext.toolCallLedger,
          turn: ctx.turn,
          parentToolUseId,
          onNestedCall: (e) => ctx.emit('nested_tool_call', e),
        });
      },
      // PR 5 — wire failure-streak guard. State lives on ctx so it
      // survives across turns within the run. The intervention callback
      // mirrors to `tool_loop_intervention` so the dashboard sees the
      // banner identically to the other guard kinds.
      failureStreakState: ctx.failureStreaks,
      onFailureStreakIntervention: (payload) => {
        ctx.emit('tool_loop_intervention', {
          kind: 'failure-streak',
          turn: payload.turn,
          toolName: payload.toolName,
          count: payload.count,
          firstFailureTurn: payload.firstFailureTurn,
          lastError: payload.lastError,
          severity: 'informational',
          reason: `Tool '${payload.toolName}' has failed ${payload.count}x in a row; original error preserved.`,
        });
      },
    });

    const toolMessage = buildToolMessage(dispatch.results);
    ctx.messages.push(toolMessage);

    // Vision: tools that returned `extraUserBlocks` (e.g. view_image,
    // preview_screenshot) get them surfaced as a synthetic user message
    // right after the tool message, so the model actually SEES the image.
    // Provider-agnostic (a user-role image block works everywhere).
    ctx.messages.push(...toolExtraUserMessages(dispatch.results));

    // Telemetry — persist BEFORE tool_call_result handlers in `index.ts`
    // flush. The flushPendingTurn read happens on the NEXT turn's
    // `turn_start`, so any order before that point is fine; doing it
    // here keeps the row write co-located with the dispatch result that
    // produced its `largest_tool_result_chars` value.
    const toolResultBlocks = Array.isArray(toolMessage.content) ? toolMessage.content : [];
    runPersistTelemetry(toolResultBlocks);

    if (dispatch.outcomeUnknown) {
      // Stop only the precomputed batch. Feed its actual results to the model
      // so it can inspect state in the SAME chat without replaying the effect.
      // Registration must complete before a fresh branch can admit any calls.
      await ctx.opts.toolContext.commitToolOutcomeRecovery?.();
      await synchronizeOutcomeRecovery(ctx, dispatch.results
        .filter(r => r.effectOutcome === 'unknown').map(r => r.toolUseId));
      ctx.opts.toolContext.toolCallLedger = ctx.opts.toolContext.toolCallLedger?.continueAfterOutcomeRegistration();
    }

    // Fix B — advance loop-aware compaction signals every turn, BEFORE any
    // early return below, so `stuck-progress` / `cumulative` work even when the
    // provider omits `usage` (the ChatGPT backend — why session 887 never
    // compacted). `cumulativeInputTokens` uses the real prompt-token count when
    // present, else the tokenizer estimate of what we just sent.
    const hadText = result.textBlocks.some((t) => t.trim().length > 0);
    ctx.consecutiveNoTextTurns = hadText ? 0 : ctx.consecutiveNoTextTurns + 1;
    // Burn metric stays on RAW input tokens (uncached slice) — adding cache
    // reads would re-count the whole cached prefix every turn.
    ctx.cumulativeInputTokens += result.usage?.input_tokens ?? estPromptTokens;

    // Per-turn loop backstop: dominance remains active for long zero-text
    // grinds. Only
    // pollable tools are exempted inside the helper; volatile calls still get
    // ordinary failure/dominance protection. Evaluated
    // only when the per-call guards didn't already flag a
    // loop — they're more specific, so they win. On a fire the helper resets
    // both windows; we route to Planning to break the loop.
    if (!dispatch.toolLoopDetected) {
      const perTurnLoop = evaluatePerTurnLoops({
        toolUses: result.toolUses,
        hadText,
        repeatableNames: new Set(
          ctx.opts.registry.list()
            .filter((t) => {
              const repeatPolicy = resolveToolMetadata(t).repeatPolicy;
              return repeatPolicy === 'pollable';
            })
            .map((t) => t.name),
        ),
        dominance: ctx.dominance,
      });
      if (perTurnLoop) {
        ctx.emit('tool_loop_intervention', {
          kind: perTurnLoop.interventionKind,
          turn: ctx.turn,
          toolName: perTurnLoop.toolName,
          count: perTurnLoop.count,
          threshold: perTurnLoop.threshold,
          window: perTurnLoop.window,
          severity: 'informational',
          snapshot: perTurnLoop.snapshot,
          reason: perTurnLoop.reason,
        });
        // Different, productive operations may share a tool name (notably code_exec).
        // Keep the diagnostic; resource budgets and health checks govern termination.
      }
    }

    if (dispatch.toolLoopDetected && !dispatch.outcomeUnknown) {
      return events.toolLoopDetected({
        guard: dispatch.loopGuard ?? 'tuple-hash',
        ...(dispatch.loopDetail ?? {}),
      });
    }

    // Semantic chapter mode: lifecycle hooks may queue a milestone, but a
    // milestone must never manufacture context pressure. It only labels the
    // next REAL size-triggered compaction below. Previously 12 messages or
    // 20K chars were enough to emit a fake ratio=1 TokenThresholdHit; on a 1M
    // model that could rewrite a ~190K prompt after an unrelated tool success.
    const milestoneTrigger = ctx.bridge?.peekMilestoneCompaction?.() ?? null;

    // Fix B — compaction decision. Works WITH or WITHOUT provider `usage`:
    // when usage is absent (the ChatGPT backend) we fall back to the
    // calibrated tokenizer ESTIMATE of what we just sent. `promptTokens` is
    // the honest cache-inclusive total computed above (same number shown in
    // the dashboard). Three gates, OR-ed for the earliest trigger:
    //   - shouldCompact90        — total-context ratio (resolveTriggerRatio, 0.90),
    //   - shouldCompactBodyAfterPrefix — prefix-cache-aware body ratio (−0.05),
    //   - evaluateLoopAwareCompaction  — behavioral (stuck-progress/cumulative)
    //     + a token-budget backstop aligned to the same ratio.
    const loopAware = evaluateLoopAwareCompaction({
      model: ctx.opts.provider.model,
      contextWindow: ctx.opts.contextWindow,
      snapshotTotal: promptTokens,
      cumulativeInputTokens: ctx.cumulativeInputTokens - ctx.cumulativeAtLastCompaction,
      consecutiveNoTextTurns: ctx.consecutiveNoTextTurns,
    });
    const bodyDecision = shouldCompactBodyAfterPrefix({
      promptTokens,
      prefixTokens: prefixTokensEstimate,
      model: ctx.opts.provider.model,
      contextWindow: ctx.opts.contextWindow,
    });
    const totalDecision = shouldCompact90({
      promptTokens,
      model: ctx.opts.provider.model,
      contextWindow: ctx.opts.contextWindow,
    });
    if (loopAware.shouldCompact || bodyDecision.shouldCompact || totalDecision.shouldCompact) {
      // Camada 2 — breaker de no-op. Se as últimas compactações não reduziram
      // nada (contexto irredutível: ex. um tool_result maior que o teto da
      // cauda), parar de rotear para Compacting a cada turno. Diferente do
      // pre-emit (que ABORTA a >90%), aqui apenas SUPRIMIMOS o churn do gate
      // de tamanho — sem abortar; o modelo segue progredindo. O clamp do recede
      // (Camada 1) + o pre-emit tornam isto raro e auto-curável (uma
      // compactação real reseta o contador, ou ele zera quando o gate silencia).
      const noopCap = 2;
      if (ctx.consecutiveNoopCompactions >= noopCap) {
        dbg(
          `compaction suppressed — context irreducible after ` +
          `${ctx.consecutiveNoopCompactions} no-op passes ` +
          `[${usageSource}=${promptTokens}] ratio=${Math.max(bodyDecision.ratio, totalDecision.ratio).toFixed(3)}`,
        );
        return decideTerminal(ctx);
      }
      dbg(
        `compaction gate fired [${usageSource}=${promptTokens}]: ` +
        `loop=${loopAware.shouldCompact}(${loopAware.reason}) ` +
        `body=${bodyDecision.shouldCompact}(${bodyDecision.ratio.toFixed(3)}) ` +
        `total=${totalDecision.shouldCompact}(${totalDecision.ratio.toFixed(3)})`,
      );
      // Prefer the higher size ratio for the event payload; behavioral-only
      // fires (ratio 0) report 1 so downstream telemetry reads "at cap".
      const ratio = Math.max(bodyDecision.ratio, totalDecision.ratio);
      // A6 — most specific gate wins for telemetry: a behavioral reason
      // (polling-loop/stuck-progress/cumulative) over the generic size gates.
      const pressureTrigger = loopAware.shouldCompact
        ? loopAware.reason
        : totalDecision.shouldCompact
          ? 'token-budget'
          : 'body-after-prefix';
      // A queued semantic milestone may label a compaction only when a real
      // prompt-size gate fired. Behavioral-only gates (cumulative/stuck) keep
      // their causal trigger and cannot accidentally consume the milestone.
      const trigger = milestoneTrigger && (totalDecision.shouldCompact || bodyDecision.shouldCompact)
        ? milestoneTrigger
        : pressureTrigger;
      return events.tokenThresholdHit({ ratio: ratio > 0 ? ratio : 1, trigger });
    }

    // Perf W1 — the gate hasn't fired but the prompt is close to the trigger:
    // start the compaction summary in the BACKGROUND so the eventual
    // Compacting pass consumes a ready result instead of stalling the run
    // inline (telemetry: summarizer turns averaged 156s vs 40s normal).
    if (shouldKickPrecompute(Math.max(bodyDecision.ratio, totalDecision.ratio))) {
      maybeKickSummaryPrecompute(ctx);
    }

    // Gate quiet — the prompt is back under the trigger, so any future genuine
    // trigger should start a fresh no-op streak.
    ctx.consecutiveNoopCompactions = 0;
    return decideTerminal(ctx);
    } finally {
      // Includes preparation exits, stream failures, cancellation and clean finish.
      await persistence.wait();
    }
  }
}
