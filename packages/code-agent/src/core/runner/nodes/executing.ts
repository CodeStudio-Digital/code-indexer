/**
 * Executing node — drives ONE full provider turn.
 *
 * Pipeline:
 *   1. bump `ctx.turn`, emit `turn_start`.
 *   2. assemble messages (via assembly + bridge callbacks for skills /
 *      active-context).
 *   3. build tools (via assembly).
 *   4. assemble system prompt (base + quality-feedback suffix).
 *   5. stream `provider.chat()` with the full ChatRequest legacy passes.
 *   6. push assistant message.
 *   7. dispatch tools — pre-read + tuple-hash gates, smart-reducer +
 *      polling-stuck on results.
 *   8. push tool-role message, emit per-tool telemetry.
 *   9. fire-and-forget quality watchdog (bridge.runQualityCheck).
 *  10. decide next event:
 *        - dedup refusal         → ToolLoopDetected (→ Planning)
 *        - token usage ≥ 90% eff → TokenThresholdHit (→ Compacting)
 *        - assistant text only   → CleanFinish
 *        - turn == maxTurns      → MaxTurnsReached or auto-continue
 *        - otherwise             → TurnSucceeded
 */
import type { BehaviorEvent, BehaviorNode, RunContext } from '../machine/types.js';
import type { ChatDelta, ContentBlock } from '@mcp/code-agent/core/messages.js';
import { promptTokensTotal } from '@mcp/code-agent/core/messages.js';
import { deriveTokenLimits } from '@mcp/code-agent/core/compaction/limits.js';
import { events } from '../machine/events.js';
import { accumulateUsage } from '../machine/context.js';
import { envTunables } from '@mcp/code-agent/core/tunables.js';
import { assembleMessagesForChat } from '../assembly/messages.js';
import { buildTools, fingerprintToolsJson } from '../assembly/tools.js';
import { computePrefixHeadHash } from '../telemetry/prefix-head.js';
import { filterByTiers } from '@mcp/code-agent/tools/tiers.js';
import { buildLoopEnforcementMarker } from '../markers.js';
import { shouldCompact90 } from '../compaction/threshold.js';
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
  renderUserMemoryBlock,
  hashSessionState,
} from '../assembly/session-state.js';
import { resolveInjectionPolicy } from '../assembly/injection-policy.js';
import { applySelfReviewDecline, computeSelfReviewNudge } from './executing-self-review.js';
import { maybePlanNudge, maybeGoalVerifyNudge } from './executing-plan-gate.js';
import { consumeStream } from './executing-stream.js';
import { dispatchTools, buildToolMessage } from './executing-dispatch.js';
import { buildNestedToolObserver, nestedGuardsEnabled } from '../guards/nested-observer.js';
import { evaluatePerTurnLoops } from './executing-loop-guards.js';
import { applyVisionFallback } from '../vision-fallback.js';
import { getGlobalVisionDescriber } from '@mcp/code-agent/core/vision-describer.js';
import {
  decideTerminal,
  runQualityCheck,
  joinText,
  providerErrorEvent,
} from './executing-decisions.js';
import { withAbort, isAbortError } from './executing-abort.js';

const DEBUG = process.env.CODER_BT_DEBUG === '1';
function dbg(...args: unknown[]): void {
  if (DEBUG) console.log('[bt-debug]', ...args);
}

/**
 * Concise list of the tools this agent can call right now — registry filtered
 * by the active tiers (the same set the model is advertised), each with a
 * one-line description. Feeds the loop-enforcement reminder so the agent is
 * reminded what to do INSTEAD of the call it keeps repeating.
 */
function availableTools(ctx: RunContext): Array<{ name: string; description: string }> {
  const all = ctx.opts.registry.list();
  const visible = ctx.activeTiers ? filterByTiers(all, ctx.activeTiers) : all;
  return visible
    .map((t) => ({ name: t.name, description: firstLine(t.description) }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function firstLine(desc: string): string {
  const line = (desc ?? '').split('\n', 1)[0].trim();
  return line.length > 80 ? `${line.slice(0, 77)}...` : line;
}

/** Latest user-message text — the "current task" signal for memory retrieval. */
function latestUserTaskText(messages: RunContext['messages']): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i] as { role?: string; content?: unknown };
    if (m.role !== 'user') continue;
    const c = m.content;
    if (typeof c === 'string') return c.trim();
    if (Array.isArray(c)) {
      return c
        .map((b) =>
          typeof b === 'string'
            ? b
            : b && typeof b === 'object' && 'text' in b
              ? String((b as { text?: unknown }).text ?? '')
              : '',
        )
        .join(' ')
        .trim();
    }
    return '';
  }
  return '';
}

export class ExecutingNode implements BehaviorNode {
  readonly state = 'Executing' as const;

  async execute(ctx: RunContext, _lastEvent: BehaviorEvent | null): Promise<BehaviorEvent> {
    ctx.turn++;
    ctx.emit('turn_start', ctx.turn);
    // A1 — expire the loop signatures Planning retained across its dedup
    // reset. They block ONLY the immediately-following turn; after that the
    // agent gets the true clean slate (legit re-verify workflows resume).
    if (ctx.retainedLoopKeys && ctx.turn > ctx.retainedLoopKeys.expiresAfterTurn) {
      for (const key of ctx.retainedLoopKeys.keys) ctx.dupCalls.delete(key);
      ctx.retainedLoopKeys = null;
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
    if (!ignoreMemory && ctx.bridge?.getRelevantProjectMemory) {
      const taskText = memoryTaskText;
      if (taskText && (ctx.turn === 1 || taskText !== ctx.injectionState.lastMemoryQuery)) {
        try {
          ctx.injectionState.pendingMemory = await ctx.bridge.getRelevantProjectMemory(taskText, ctx.turn);
          ctx.injectionState.lastMemoryQuery = taskText;
        } catch (e) {
          dbg('memory retrieval failed', (e as Error).message);
        }
      }
    }

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
        !selfReviewNudge &&
        !sessionState &&
        !projectMemoryIndex &&
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
        hasReviewableChanges: selfReviewNudge,
        sessionState,
        sessionStateEveryTurn: policy.stateEveryTurn,
        lastInjectedSessionStateHash: ctx.injectionState.lastInjectedSessionStateHash,
        projectMemoryIndex,
        lastInjectedProjectIndexHash: ctx.injectionState.lastInjectedProjectIndexHash,
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
      if (injectionToCommit.includedSessionStateHash) {
        ctx.injectionState.lastInjectedSessionStateHash = injectionToCommit.includedSessionStateHash;
      }
      if (injectionToCommit.includedProjectIndexHash) {
        ctx.injectionState.lastInjectedProjectIndexHash = injectionToCommit.includedProjectIndexHash;
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

    const toolsBuilt = buildTools({
      registry: ctx.opts.registry,
      globalDisabledTools: ctx.opts.globalDisabledTools,
      sessionDisabledTools: ctx.opts.sessionDisabledTools,
      externalToolTiers: ctx.opts.externalToolTiers,
      activeTiers: ctx.activeTiers,
      pinnedTools: ctx.pinnedTools,
      sessionToolCap: ctx.opts.sessionToolCap,
      toolContext: ctx.opts.toolContext,
      provider: ctx.opts.provider,
    });
    dbg(`tools=${toolsBuilt.tools.length} tiers=${ctx.activeTiers === null ? '*' : Array.from(ctx.activeTiers).join(',')}`);

    const qualitySuffix = ctx.bridge?.buildQualityFeedbackSuffix?.() ?? '';
    const systemPrompt = qualitySuffix ? `${ctx.opts.systemPrompt}${qualitySuffix}` : ctx.opts.systemPrompt;

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
    const prefixTokensEstimate = computePrefixTokens(systemPrompt, toolsBuilt.tools);
    const preEmit = shouldCompactPreEmit({
      messages: messagesForChat,
      // No pending tool_results at this point in the loop — the model
      // hasn't emitted the next tool batch yet. Just messages + prefix.
      prefixTokens: prefixTokensEstimate,
      model: ctx.opts.provider.model,
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
      toolCount: toolsBuilt.tools.length,
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

    let stream: AsyncIterable<ChatDelta>;
    try {
      dbg(`calling provider.chat() model=${ctx.opts.provider.model}`);
      ctx.operations.progress(providerOpId, { phase: 'provider.chat' });
      stream = ctx.opts.provider.chat({
        system: systemPrompt,
        messages: chatMessages,
        tools: toolsBuilt.tools,
        thinking: ctx.opts.thinking,
        thinkingBudgetTokens: ctx.opts.thinkingBudgetTokens,
        ...(ctx.opts.reasoningEffort
          ? { reasoningEffort: ctx.opts.reasoningEffort }
          : {}),
        sessionId: ctx.opts.sessionId,
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
      ctx.operations.progress(providerOpId, {
        phase: 'streaming',
        note: `awaiting ${ctx.opts.provider.name}:${ctx.opts.provider.model}`,
      });
      ctx.emit('tool_progress', {
        id: providerOpId,
        name: 'provider.chat',
        elapsedMs: Date.now() - streamStartedAt,
        note: `awaiting ${ctx.opts.provider.name}:${ctx.opts.provider.model}…`,
      });
    }, STREAM_HEARTBEAT_MS);

    let result: Awaited<ReturnType<typeof consumeStream>>;
    try {
      result = await consumeStream({
        stream,
        signal: ctx.opts.toolContext.signal,
        onTextDelta: (text) => {
          ctx.operations.progress(providerOpId, { phase: 'text_delta' });
          ctx.emit('text_delta', text);
        },
        onThinkingDelta: (text) => {
          ctx.operations.progress(providerOpId, { phase: 'thinking_delta' });
          ctx.emit('thinking_delta', text);
        },
      });
    } catch (e) {
      dbg('consumeStream threw', e);
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
    dbg(`stream done text=${result.textBlocks.length}b tools=${result.toolUses.length} usage_in=${result.usage?.input_tokens ?? '?'}`);

    accumulateUsage(ctx, result.usage);

    if (result.responseId !== null && result.responseMessageCount !== null) {
      ctx.bridge?.onResponseId?.(result.responseId, result.responseMessageCount);
    }

    // Telemetry persistence helper — invoked from BOTH the text-only path
    // (no tool_uses) and the tool-dispatch path. The pure function lives
    // in `core/runner/telemetry/persist-turn.ts`; the bridge wrapper in
    // `runner.ts` adds class-bound side effects (quality classifier
    // dispatch + tool-selection feedback observer) and updates
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
        const json = JSON.stringify(toolsBuilt.tools);
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
          visibleToolsCount: toolsBuilt.tools.length,
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
        ctx.lastTurnTelemetryId = id;
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
      const limits = deriveTokenLimits(ctx.opts.provider.model);
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
      // A1 goal-completion gate (CODER_GOAL_VERIFY): before letting a text-only
      // finish end the run, an INDEPENDENT read-only verifier confirms the goal
      // is actually met. A 'not met' verdict re-enters the turn with the gaps;
      // fail-open + bounded by ctx.goalVerifyAttempts. See executing-plan-gate.
      const goalNudge = await maybeGoalVerifyNudge(ctx);
      if (goalNudge) {
        ctx.messages.push({ role: 'user', content: [{ type: 'text', text: goalNudge }] });
        return events.turnSucceeded({ hasToolCalls: false });
      }
      // Text-only assistant turn ends the run — no tool_use means the
      // model is delivering its final reply.
      runQualityCheck(ctx, joinText(result.textBlocks), [], result.toolUses);
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

    const dispatch = await dispatchTools({
      toolUses: result.toolUses,
      registry: ctx.opts.registry,
      toolContext: ctx.opts.toolContext,
      turn: ctx.turn,
      dupCalls: ctx.dupCalls,
      loopRefusals: ctx.loopRefusals,
      // Pin mechanism — hidden registered tools execute and join the
      // visible list next turn; disabled tools hard-block at dispatch.
      visibleToolNames: new Set(toolsBuilt.tools.map((t) => t.name)),
      pinnedTools: ctx.pinnedTools,
      onToolPinned: (name) => ctx.pinnedTools.add(name),
      isToolBlocked: (name) =>
        ctx.opts.globalDisabledTools?.has(name)
          ? `[tool-disabled] '${name}' is disabled globally by the admin — pick another tool (find_tools lists alternatives).`
          : ctx.opts.sessionDisabledTools?.has(name)
            ? `[tool-disabled] '${name}' is disabled for this session — pick another tool (find_tools lists alternatives).`
            : null,
      toolGate: ctx.bridge?.toolGate,
      enforcePreRead: ctx.bridge?.enforcePreRead,
      enforceTaskMode: ctx.bridge?.enforceTaskMode,
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
      onToolProgress: (id, name, elapsedMs, note) => {
        ctx.operations.progress(`tool:${id}`, { phase: 'running', ...(note ? { note } : {}) });
        ctx.emit('tool_progress', { id, name, elapsedMs, ...(note ? { note } : {}) });
      },
      // Nested-call guards (code_exec): one observer per code_exec parent,
      // closing over the run's OWN dupCalls/failureStreaks so nested calls
      // count against the same state as direct ones. The telemetry sink
      // emits `nested_tool_call` for the per-call audit trail.
      makeNestedObserver: (parentToolUseId, parentToolName) => {
        if (parentToolName !== 'code_exec' || !nestedGuardsEnabled()) return undefined;
        return buildNestedToolObserver({
          dupCalls: ctx.dupCalls,
          failureStreaks: ctx.failureStreaks,
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
          input: inputByUseId.get(r.toolUseId),
          refusalKind: r.refusalKind,
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

    // Fire-and-forget quality classifier. Errors must NOT block the turn.
    runQualityCheck(ctx, joinText(result.textBlocks), dispatch.results, result.toolUses);

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

    // Insistent-loop enforcement — the same tool+args got hard-refused across
    // multiple planning cycles. A passive refusal alone never breaks it (the
    // dedup table resets each cycle), so inject an ACTIVE steering reminder
    // that re-lists the available tools and orders a strategy change, then let
    // the normal ToolLoopDetected routing send us to Planning.
    if (dispatch.loopEnforcement) {
      const { toolName, count } = dispatch.loopEnforcement;
      ctx.bridge?.injectSystemReminder?.(
        buildLoopEnforcementMarker({ toolName, count, tools: availableTools(ctx) }),
      );
      ctx.emit('tool_loop_intervention', {
        kind: 'loop-enforced',
        turn: ctx.turn,
        toolName,
        count,
        severity: 'enforced',
        reason:
          `Tool '${toolName}' was refused ${count}x across planning cycles — ` +
          `injected an enforcement reminder (available tools + break-the-loop order).`,
      });
    }

    // Per-turn loop backstops (P0): doom-loop (same tool signature recurs
    // across turns — rotating-args / once-per-turn repeats the per-call guards
    // can't see) + dominance (one tool grinding a long window with zero
    // assistant text). Polling/`repeatable` tools are exempted inside the
    // helper. Evaluated only when the per-call guards didn't already flag a
    // loop — they're more specific, so they win. On a fire the helper resets
    // both windows; we route to Planning to break the loop.
    if (!dispatch.toolLoopDetected) {
      const perTurnLoop = evaluatePerTurnLoops({
        toolUses: result.toolUses,
        hadText,
        repeatableNames: new Set(
          ctx.opts.registry.list().filter((t) => t.repeatable).map((t) => t.name),
        ),
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
      snapshotTotal: promptTokens,
      cumulativeInputTokens: ctx.cumulativeInputTokens - ctx.cumulativeAtLastCompaction,
      consecutiveNoTextTurns: ctx.consecutiveNoTextTurns,
    });
    const bodyDecision = shouldCompactBodyAfterPrefix({
      promptTokens,
      prefixTokens: prefixTokensEstimate,
      model: ctx.opts.provider.model,
    });
    const totalDecision = shouldCompact90({ promptTokens, model: ctx.opts.provider.model });
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
      const trigger = loopAware.shouldCompact
        ? loopAware.reason
        : totalDecision.shouldCompact
          ? 'token-budget'
          : 'body-after-prefix';
      return events.tokenThresholdHit({ ratio: ratio > 0 ? ratio : 1, trigger });
    }

    // Gate quiet — the prompt is back under the trigger, so any future genuine
    // trigger should start a fresh no-op streak.
    ctx.consecutiveNoopCompactions = 0;
    return decideTerminal(ctx);
  }
}
