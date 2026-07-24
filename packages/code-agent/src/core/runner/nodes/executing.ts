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
import { promptTokensTotal } from '@mcp/code-agent/core/messages.js';
import { deriveTokenLimits } from '@mcp/code-agent/core/compaction/limits.js';
import { events } from '../machine/events.js';
import { accumulateUsage } from '../machine/context.js';
import { envTunables } from '@mcp/code-agent/core/tunables.js';
import { assembleMessagesForChat } from '../assembly/messages.js';
import {
  buildTools,
  buildToolsCacheKey,
  enforceAtomicGoalToolPair,
  fingerprintToolsJson,
  type BuildToolsResult,
} from '../assembly/tools.js';
import { computePrefixHeadHash } from '../telemetry/prefix-head.js';
import { resolveToolMetadata } from '@mcp/code-agent/core/policy.js';
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
import { maybePlanNudge, maybeGoalCompletionRefusal } from './executing-plan-gate.js';
import {
  evaluateGoalLifecycleAtFinish,
  goalLifecycleRefusalBeforeTool,
} from './executing-goal-gate.js';
import {
  evaluateVerificationReadinessAtFinish,
  maybeVerificationCompletionRefusal,
  maybeVerificationNudge,
} from './executing-verification-gate.js';
import { consumeStream, thinkingOnlyBudgetMs } from './executing-stream.js';
import { dispatchTools, buildToolMessage } from './executing-dispatch.js';
import { buildNestedToolObserver, nestedGuardsEnabled } from '../guards/nested-observer.js';
import { dedupPolicyMode } from '../guards/tuple-hash-dedup.js';
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
  observePromptCache,
  promptCacheMissGuardMessage,
} from '../guards/prompt-cache-miss.js';

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
  const rawCode = typeof record.code === 'string' ? record.code : fallbackCode;
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
    // Never persist a provider message here: SDK errors may echo prompts,
    // signed URLs or credentials. The class is sufficient for diagnosis while
    // adapter-owned telemetry may add an opaque correlation hash.
    errorMessage: error instanceof Error ? error.name : 'UnknownError',
  };
}

/**
 * Concise list of the tools this agent can call right now — registry filtered
 * by the active tiers (the same set the model is advertised), each with a
 * one-line description. Feeds the loop-enforcement reminder so the agent is
 * reminded what to do INSTEAD of the call it keeps repeating.
 */
export class ExecutingNode implements BehaviorNode {
  readonly state = 'Executing' as const;

  async execute(ctx: RunContext, _lastEvent: BehaviorEvent | null): Promise<BehaviorEvent> {
    if (ctx.cacheMissGuardError) {
      ctx.stopReason = 'error';
      ctx.error = ctx.cacheMissGuardError;
      return events.aborted();
    }
    ctx.turn++;
    ctx.emit('turn_start', ctx.turn);
    // `turn_start` synchronously asks the host to enqueue persistence for the
    // preceding assistant/tool turn. Do not let a new provider call — and thus
    // no new tool side effect — overtake that transaction. Rejections bubble to
    // the orchestrator, which emits a terminal error instead of continuing on
    // state that failed its goal CAS/durability boundary.
    await ctx.bridge?.awaitTurnPersistence?.();
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
    const ignoreMemory =
      /\b(ignore|disregard|skip|don'?t use|do not use|n[aã]o use|n[aã]o usar)\b[\s\S]{0,20}mem(?:o|ó)r(?:y|ia)\b(?!\s*(?:leak|leaks|usage|check|checks|profile|profiler|pressure|footprint|heap|ram|cache))/i.test(
        memoryTaskText ?? '',
      );
    // Perf W1 — the two recall blocks below are independent (distinct
    // injectionState fields + throttle keys) yet ran serially, both awaited
    // on the critical path before the provider call. Run them concurrently;
    // the internal synthesize→retrieve dependency of the project-memory
    // block is preserved inside its closure.
    const recallProjectMemory = async (): Promise<void> => {
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
        ctx.injectionState.pendingMemory = await ctx.bridge.getRelevantProjectMemory(memoryQuery, ctx.turn);
        ctx.injectionState.lastMemoryQuery = candidate; // STABLE throttle key
      } catch (e) {
        dbg('memory retrieval failed', (e as Error).message);
      }
    };

    // Session-local history uses the same material-task-change throttle as
    // project memory, but retrieval is independently bounded to two excerpts.
    const recallConversationChapters = async (): Promise<void> => {
      if (!ctx.bridge?.getRelevantConversationChapters) return;
      const { candidate, shouldRetrieve } = planMemoryRecall(
        memoryTaskText,
        ctx.messages,
        ctx.injectionState.lastConversationChapterQuery,
        ctx.turn,
      );
      if (!shouldRetrieve || !candidate.trim()) return;
      try {
        ctx.injectionState.pendingConversationChapters =
          await ctx.bridge.getRelevantConversationChapters(candidate, ctx.turn);
        ctx.injectionState.lastConversationChapterQuery = candidate;
      } catch (e) {
        dbg('conversation chapter retrieval failed', (e as Error).message);
      }
    };
    await Promise.all([recallProjectMemory(), recallConversationChapters()]);

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
      const selfReviewNudge = computeSelfReviewNudge(ctx);
      // Session State Block — the always-alive structured state (goal/plan/
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
            const chapterIndex = ctx.bridge?.getConversationChapterIndex?.() ?? null;
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
      const preflightHint = ctx.opts.preflightHint
        ? { text: ctx.opts.preflightHint, hash: hashSessionState(ctx.opts.preflightHint) }
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
      messages: ctx.messages,
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
    const toolsMemoKey =
      buildToolsCacheKey({ activeTiers: ctx.activeTiers, pinnedTools: ctx.pinnedTools }) +
      `|cap=${ctx.opts.sessionToolCap ?? ''}` +
      `|terse=${String(ctx.terseDescriptionsLock)}` +
      `|model=${ctx.opts.provider.model ?? ''}`;
    let toolsBuilt: BuildToolsResult;
    if (ctx.toolsMemo && ctx.toolsMemo.key === toolsMemoKey) {
      toolsBuilt = ctx.toolsMemo.built;
    } else {
      toolsBuilt = buildTools({
        registry: ctx.opts.registry,
        globalDisabledTools: ctx.opts.globalDisabledTools,
        sessionDisabledTools: ctx.opts.sessionDisabledTools,
        externalToolTiers: ctx.opts.externalToolTiers,
        activeTiers: ctx.activeTiers,
        pinnedTools: ctx.pinnedTools,
        sessionToolCap: ctx.opts.sessionToolCap,
        terseDescriptionsLock: ctx.terseDescriptionsLock,
        toolContext: ctx.opts.toolContext,
        provider: ctx.opts.provider,
      });
      ctx.toolsMemo = { key: toolsMemoKey, built: toolsBuilt, variants: new Map() };
    }
    // Recovery is a state-dependent capability: exposing get_tool_output
    // before the session has any stored snapshot invites the model to invent
    // an ID. Rebuild runs every provider turn, so the tool appears immediately
    // after the first successful spill and remains available on resume.
    const outputStore = ctx.opts.toolContext.toolOutputStore;
    const hasRecoverableOutput = outputStore
      ? typeof outputStore.hasOutputs === 'function'
        ? outputStore.hasOutputs()
        : true // compatibility for narrow test/host stubs
      : false;
    const toolsVariantKey = hasRecoverableOutput ? 'full' : 'no-recover';
    let toolsVariant = ctx.toolsMemo.variants.get(toolsVariantKey);
    if (!toolsVariant) {
      toolsVariant = {
        tools: hasRecoverableOutput
          ? toolsBuilt.tools
          : toolsBuilt.tools.filter((tool) => tool.name !== 'get_tool_output'),
        json: null,
        fingerprint: null,
      };
      ctx.toolsMemo.variants.set(toolsVariantKey, toolsVariant);
    }
    const availableTools = toolsVariant.tools;
    let toolsForModel = availableTools;
    if (ctx.opts.toolSelectionFilter) {
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
          protectedToolNames: new Set([
            ...toolsBuilt.protectedToolNames,
            ...ctx.pinnedTools,
          ]),
        });
        // The primary feature gate already opted into selection. APPLY=0 is
        // the explicit shadow-only escape hatch; requiring a second positive
        // flag silently left production catalogs unfiltered (session 1263:
        // 110 eligible and 110 visible despite the reducer being enabled).
        if (process.env.MCP_PIPELINES_TOOL_SELECTION_APPLY !== '0' && selected.length > 0) {
          // Selection is relevance-ranked internally, but provider tool order
          // is not a recommendation channel. Keep a stable catalog order so
          // identical memberships retain the same prompt-cache prefix.
          toolsForModel = [...selected].sort((a, b) => a.name.localeCompare(b.name));
        }
      } catch (e) {
        console.warn(`[coder] tool-selection failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    // Custom/relevance selectors run after buildTools, but lifecycle tools are
    // protected capabilities rather than ordinary relevance candidates.
    // Restore the pair from the authoritative post-policy surface if a buggy
    // selector omitted either/both; roles/disabled sets lacking the pair stay
    // pairless and fail open.
    toolsForModel = enforceAtomicGoalToolPair(toolsForModel, availableTools);
    dbg(`tools=${toolsForModel.length} tiers=${ctx.activeTiers === null ? '*' : Array.from(ctx.activeTiers).join(',')}`);

    const systemPrompt = ctx.opts.systemPrompt;

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
      ctx.consecutiveNoopCompactions >=
        (Number(process.env.CODER_POSTTURN_COMPACT_NOOP_MAX ?? '2') || 2) &&
      preEmit.projectedTokens <= preEmit.effective;
    if (preEmit.shouldCompact && !preEmitIrreducible) {
      // The decrement below means `maxTurns` can't backstop a pre-emit
      // compaction that keeps firing without ever freeing the window
      // (e.g. the protected tail alone exceeds 90%, or a huge tool_result
      // sits in the protected zone). Bound the consecutive cycles
      // explicitly: after `cap` passes in a row the context is
      // irreducible — abort cleanly rather than loop forever.
      ctx.preEmitCompactions += 1;
      const cap = Number(process.env.CODER_PREEMIT_COMPACT_MAX ?? '3') || 3;
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
      ctx.opts.sessionStore?.recordProviderAttempt({
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
    };
    let result!: Awaited<ReturnType<typeof consumeStream>>;
    try {
    let stream: AsyncIterable<ChatDelta>;
    try {
      dbg(`calling provider.chat() model=${ctx.opts.provider.model}`);
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
        signal: ctx.opts.toolContext.signal,
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
    const STREAM_HEARTBEAT_MS =
      Number(process.env.CODER_STREAM_HEARTBEAT_MS ?? '10000') || 10_000;
    const streamStartedAt = Date.now();
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
        signal: ctx.opts.toolContext.signal,
        // Scale the thinking-only watchdog by reasoning effort and by how many
        // thinking-timeouts already fired this run, so a retry gets a strictly
        // larger budget than the attempt that just timed out (a same-budget
        // retry of the same prompt re-times-out identically and burns the cap).
        thinkingOnlyTimeoutMs: thinkingOnlyBudgetMs(
          ctx.opts.reasoningEffort,
          ctx.recovery.get('provider-thinking-timeout') ?? 0,
        ),
        onTextDelta: (text) => {
          // Keep operation liveness accurate without mirroring every token as
          // a second `operation_progress` event. The 10s stream heartbeat
          // above remains the sampled progress signal for diagnostics/UI.
          ctx.operations.touch(providerOpId, { phase: 'text_delta' });
          ctx.emit('text_delta', text);
        },
        onThinkingDelta: (text) => {
          ctx.operations.touch(providerOpId, { phase: 'thinking_delta' });
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
    ctx.transientRetriesThisTurn = 0;

    const cacheObservation = observePromptCache(
      ctx.opts.provider.name,
      result.usage,
      ctx.consecutiveLargePromptCacheMisses,
    );
    ctx.consecutiveLargePromptCacheMisses = cacheObservation.consecutiveMisses;
    if (cacheObservation.tripped) {
      ctx.cacheMissGuardError = new Error(
        promptCacheMissGuardMessage(cacheObservation),
      );
      console.warn(`[coder] ${ctx.cacheMissGuardError.message}`);
    }

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
    for (const tu of result.toolUses) {
      assistantContent.push({ type: 'tool_use', id: tu.id, name: tu.name, input: tu.input });
    }
    if (assistantContent.length > 0) {
      ctx.messages.push({ role: 'assistant', content: assistantContent });
      ctx.emit('message_complete', { role: 'assistant', content: assistantContent }, result.usage);
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
    {
      const limits = deriveTokenLimits(ctx.opts.provider.model, ctx.opts.contextWindow);
      ctx.emit('context_status', {
        turn: ctx.turn,
        prompt_tokens: promptTokens,
        source: usageSource,
        context_window: limits.effective,
        ratio: limits.effective > 0 ? promptTokens / limits.effective : 0,
      });
    }

    // Dashboard telemetry — preview the batch before dispatch so the UI
    // can render the pending tool list immediately (legacy parity).
    ctx.emit('tool_batch', {
      runId: ctx.runId,
      turn: ctx.turn,
      count: result.toolUses.length,
      names: result.toolUses.map((t) => t.name),
    });

    if (result.toolUses.length === 0) {
      if (ctx.cacheMissGuardError) {
        runPersistTelemetry([]);
        ctx.stopReason = 'error';
        ctx.error = ctx.cacheMissGuardError;
        return events.aborted();
      }
      // Mandatory-plan gate: in plan mode the deliverable IS a plan. If the
      // model tries to end with bare text (no submit_plan/submit_tasks, no
      // approval), inject a ONE-SHOT reminder as the next user message and
      // re-enter the turn instead of finishing. Bounded at one nudge so a
      // genuinely conversational reply still terminates. See executing-plan-gate.
      const planNudge = maybePlanNudge(ctx);
      if (planNudge) {
        ctx.messages.push({ role: 'user', content: [{ type: 'text', text: planNudge }] });
        return events.turnSucceeded({ hasToolCalls: false });
      }
      const verificationReadiness =
        ctx.opts.verificationEvidenceEnabled || ctx.bridge?.verifyGoalCompletion
          ? evaluateVerificationReadinessAtFinish(ctx)
          : undefined;
      if (ctx.opts.verificationEvidenceEnabled && verificationReadiness) {
        const verificationNudge = maybeVerificationNudge(ctx, verificationReadiness);
        if (verificationNudge) {
          // Audit the intervention (no raw commands — only classified signals)
          // so the offline eval can measure whether the nudge corrects the next
          // turn without inflating cost/loops.
          if (ctx.opts.sessionId != null) {
            try {
              ctx.opts.sessionStore?.recordSessionInput({
                session_id: ctx.opts.sessionId,
                kind: 'system_reminder',
                source_label: 'reminder:finish-evidence',
                content: verificationNudge,
                meta: {
                  status: verificationReadiness.status,
                  source: verificationReadiness.source,
                  changed_files: verificationReadiness.changedFiles.length,
                  validation_signals: verificationReadiness.validationSignals,
                  turn: ctx.turn,
                },
              });
            } catch { /* audit trail is best-effort */ }
          }
          ctx.messages.push({ role: 'user', content: [{ type: 'text', text: verificationNudge }] });
          return events.turnSucceeded({ hasToolCalls: false });
        }
      }
      // Goal lifecycle is runtime-owned at the stop boundary. The model still
      // creates/completes goals through visible tools, but a ToolCallLedger-
      // proven work run cannot silently clean-finish after skipping that
      // lifecycle. The gate is bounded; exhausting it terminates as an error
      // rather than lying to the transport with `completed`.
      const goalLifecycle = evaluateGoalLifecycleAtFinish(ctx, {
        effectiveToolNames: new Set(toolsForModel.map((tool) => tool.name)),
      });
      if (goalLifecycle?.kind === 'nudge') {
        ctx.messages.push({ role: 'user', content: [{ type: 'text', text: goalLifecycle.text }] });
        return events.turnSucceeded({ hasToolCalls: false });
      }
      if (goalLifecycle?.kind === 'violation') {
        runPersistTelemetry([]);
        ctx.stopReason = 'error';
        ctx.error = new Error(goalLifecycle.message);
        return events.aborted();
      }
      // Text-only assistant turn ends the run — no tool_use means the
      // model is delivering its final reply.
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

    const effectiveToolNames = new Set(toolsForModel.map((tool) => tool.name));
    const dispatch = await dispatchTools({
      toolUses: result.toolUses,
      registry: ctx.opts.registry,
      toolContext: ctx.opts.toolContext,
      turn: ctx.turn,
      dupCalls: ctx.dupCalls,
      noProgressTracker: ctx.noProgressTracker,
      // Pin mechanism — hidden registered tools execute and join the
      // visible list next turn; disabled tools hard-block at dispatch.
      visibleToolNames: effectiveToolNames,
      pinnedTools: ctx.pinnedTools,
      onToolPinned: (name) => ctx.pinnedTools.add(name),
      isToolBlocked: (name) => {
        if (ctx.opts.globalDisabledTools?.has(name)) {
          return `[tool-disabled] '${name}' is disabled globally by the admin — pick another tool (find_tools lists alternatives).`;
        }
        if (ctx.opts.sessionDisabledTools?.has(name)) {
          return `[tool-disabled] '${name}' is disabled for this session — pick another tool (find_tools lists alternatives).`;
        }
        if (
          (name === 'create_goal' || name === 'update_goal')
          && (
            !effectiveToolNames.has('create_goal')
            || !effectiveToolNames.has('update_goal')
          )
        ) {
          return (
            `[goal-lifecycle-disabled] '${name}' is unavailable because create_goal and ` +
            'update_goal must be exposed together; continue without session-goal lifecycle tools.'
          );
        }
        return null;
      },
      toolGate: async (name, input) => {
        const bridgeRefusal = ctx.bridge?.toolGate?.(name, input);
        if (bridgeRefusal != null) return bridgeRefusal;
        const goalRefusal = goalLifecycleRefusalBeforeTool(
          ctx,
          name,
          input,
          { effectiveToolNames },
        );
        if (goalRefusal != null) return goalRefusal;
        const completesGoal =
          name === 'update_goal'
          && input
          && typeof input === 'object'
          && !Array.isArray(input)
          && (input as Record<string, unknown>).status === 'complete';
        if (ctx.opts.verificationEvidenceEnabled && completesGoal) {
          const evidenceRefusal = maybeVerificationCompletionRefusal(ctx);
          if (evidenceRefusal != null) return evidenceRefusal;
        }
        if (completesGoal) {
          return maybeGoalCompletionRefusal(
            ctx,
            evaluateVerificationReadinessAtFinish(ctx),
          );
        }
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
      postProcessToolResult: ctx.bridge?.postProcessToolResult,
      detectPollingStuck: ctx.bridge?.detectPollingStuck,
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
          severity: payload.kind === 'refuse' ? 'refused' : 'informational',
          reason:
            payload.kind === 'refuse'
              ? `Tool '${payload.toolName}' failed ${payload.count}x in a row — forcing planning turn.`
              : `Tool '${payload.toolName}' has failed ${payload.count}x in a row — reminder injected.`,
        });
      },
    });

    const toolMessage = buildToolMessage(dispatch.results);
    ctx.messages.push(toolMessage);

    // Vision: tools that returned `extraUserBlocks` (e.g. view_image,
    // preview_screenshot) get them surfaced as a synthetic user message
    // right after the tool message, so the model actually SEES the image.
    // Provider-agnostic (a user-role image block works everywhere).
    const extraBlocks = dispatch.results.flatMap((r) => r.extraUserBlocks ?? []);
    if (extraBlocks.length > 0) {
      ctx.messages.push({
        role: 'user',
        content: [
          ...extraBlocks,
          { type: 'text', text: '(Image(s) attached from the tool call above.)' },
        ],
      });
    }

    // Refused calls never fired tool_call_start, so the telemetry listener in
    // index.ts has no pending entry to read args from — carry the original
    // input on the result event itself (along with the refusal kind).
    const inputByUseId = new Map(result.toolUses.map((t) => [t.id, t.input]));
    for (const r of dispatch.results) {
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
          isError: r.isError,
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
    }

    // Telemetry — persist BEFORE tool_call_result handlers in `index.ts`
    // flush. The flushPendingTurn read happens on the NEXT turn's
    // `turn_start`, so any order before that point is fine; doing it
    // here keeps the row write co-located with the dispatch result that
    // produced its `largest_tool_result_chars` value.
    const toolResultBlocks = Array.isArray(toolMessage.content) ? toolMessage.content : [];
    runPersistTelemetry(toolResultBlocks);

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

    // Per-turn loop backstops (P0): legacy rollback may enforce signature
    // doom-loops; hybrid/observe replace those with result-aware shadow
    // candidates. Dominance remains active for long zero-text grinds. Only
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
        signatureLoopsEnabled: dedupPolicyMode() === 'legacy',
        doom: ctx.doomLoop,
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
          severity: 'refused',
          snapshot: perTurnLoop.snapshot,
          reason: perTurnLoop.reason,
        });
        return events.toolLoopDetected({
          guard: perTurnLoop.guard,
          toolName: perTurnLoop.toolName,
          count: perTurnLoop.count,
        });
      }
    }

    if (dispatch.toolLoopDetected) {
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
      const noopCap = Number(process.env.CODER_POSTTURN_COMPACT_NOOP_MAX ?? '2') || 2;
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
  }
}
