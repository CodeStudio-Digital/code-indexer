/**
 * Executing node — drives ONE full provider turn.
 *
 * Pipeline:
 *   1. bump `ctx.turn`, emit `turn_start`.
 *   2. assemble messages (via assembly + bridge callbacks for skills /
 *      active-context).
 *   3. build tools (via assembly).
 *   4. assemble system prompt (base + quality-feedback suffix).
 *   5. deep-think pre-think (bridge.runPreThink) — prefills
 *      `<thinking data-source="aux">…</thinking>` if produced.
 *   6. stream `provider.chat()` with the full ChatRequest legacy passes.
 *   7. push assistant message.
 *   8. dispatch tools — pre-read + tuple-hash gates, smart-reducer +
 *      polling-stuck on results.
 *   9. push tool-role message, emit per-tool telemetry.
 *  10. fire-and-forget quality watchdog (bridge.runQualityCheck).
 *  11. decide next event:
 *        - dedup refusal         → ToolLoopDetected (→ Planning)
 *        - token usage ≥ 90% eff → TokenThresholdHit (→ Compacting)
 *        - assistant text only   → CleanFinish
 *        - turn == maxTurns      → MaxTurnsReached or auto-continue
 *        - otherwise             → TurnSucceeded
 */
import type { BehaviorEvent, BehaviorNode, RunContext } from '../machine/types.js';
import type { ChatDelta, ContentBlock } from '@mcp/code-agent/core/messages.js';
import { events } from '../machine/events.js';
import { accumulateUsage } from '../machine/context.js';
import { envTunables } from '@mcp/code-agent/core/tunables.js';
import { assembleMessagesForChat } from '../assembly/messages.js';
import { buildTools } from '../assembly/tools.js';
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
import { shouldCompactPreEmit } from '../compaction/pending-tokens.js';
import { computeDynamicInjection, type DynamicInjectionResult } from '../assembly/dynamic-injection.js';
import { consumeStream } from './executing-stream.js';
import { dispatchTools, buildToolMessage } from './executing-dispatch.js';
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
    // Drain any messages queued via `runner.pushUserMessage` (master →
    // subordinate forward, SSE-side push from the dashboard, etc.) so
    // they appear in `ctx.messages` BEFORE we build the request. The
    // legacy while-loop did this at the same point in the cycle; the
    // BT delegates to the bridge so the queue (`pendingUserMessages`)
    // stays owned by the host `CoderRunner` class.
    ctx.bridge?.flushPendingMessages?.();
    dbg(`Executing turn=${ctx.turn} messages=${ctx.messages.length}`);

    // Mem C — proactive project-memory retrieval. Async, so it runs HERE
    // (before the synchronous message assembly) and stashes the result in
    // injectionState for the dynamic injector to surface. Throttled: only the
    // first turn or when the task text materially changes, so we don't re-query
    // (or re-inject) every turn.
    ctx.injectionState.pendingMemory = undefined;
    if (ctx.bridge?.getRelevantProjectMemory) {
      const taskText = latestUserTaskText(ctx.messages);
      if (taskText && (ctx.turn === 1 || taskText !== ctx.injectionState.lastMemoryQuery)) {
        try {
          ctx.injectionState.pendingMemory = await ctx.bridge.getRelevantProjectMemory(taskText, ctx.turn);
          ctx.injectionState.lastMemoryQuery = taskText;
        } catch (e) {
          dbg('memory retrieval failed', (e as Error).message);
        }
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
    const dynamicInjectionFn = (): DynamicInjectionResult | null => {
      const signals = ctx.bridge?.collectDynamicInjectionSignals?.() ?? null;
      const recentCompactionAt = ctx.injectionState.recentCompactionAt;
      const pendingMemory = ctx.injectionState.pendingMemory ?? [];
      // Skip computing when nothing fresh AND no recent compaction AND no memory.
      if (!signals && recentCompactionAt == null && pendingMemory.length === 0) return null;
      const result = computeDynamicInjection({
        turn: ctx.turn,
        newlyRegisteredSkillIds: signals?.newlyRegisteredSkillIds ?? [],
        lastInjectedSkillIds: ctx.injectionState.lastInjectedSkillIds,
        recentlyEditedFiles: signals?.recentlyEditedFiles ?? [],
        lastInjectedFiles: ctx.injectionState.lastInjectedFiles,
        recentCompactionAt,
        relevantMemory: pendingMemory,
        lastInjectedMemoryIds: ctx.injectionState.lastInjectedMemoryIds,
      });
      // Stash for post-assembly commit so we don't double-update state
      // when the same injection is consulted (e.g. by tests).
      if (result) injectionResultForCommit = result;
      return result;
    };
    const messagesForChat = assembleMessagesForChat({
      messages: ctx.messages,
      tunables,
      compactionLimits: undefined,
      preThinkHistoryWindow: ctx.opts.preThinkHistoryWindow ?? 3,
      persistPreThoughts: ctx.opts.persistPreThoughts !== false,
      agentLoopV2: !!ctx.opts.agentLoopV2,
      buildActiveSkillsBlock: ctx.bridge?.buildActiveSkillsBlock ?? (() => null),
      buildActiveContextBlock: ctx.bridge?.buildActiveContextBlock ?? (() => null),
      computeDynamicInjection: dynamicInjectionFn,
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
      toolContext: ctx.opts.toolContext,
      provider: ctx.opts.provider,
      goalToolAlreadyLogged: false,
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
    });
    if (preEmit.shouldCompact) {
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
    // Gate passed — any prior compaction freed enough room, so reset the
    // consecutive-pre-emit counter. A future runaway starts counting fresh.
    ctx.preEmitCompactions = 0;

    // Deep-think pre-think (opt-in via opts.deepThink). Prefills an
    // auxiliary reasoning block onto BOTH the working window and the
    // persistent history (legacy parity). Failures degrade silently —
    // the bridge emits its own diagnostic events.
    //
    // Camada 4 — heartbeat around the entire bridge.runPreThink() await
    // so the StuckBanner doesn't trip when the aux provider's first call
    // is slow (OAuth refresh, socket warm-up, slow first-token aux model).
    // Same pattern as Camadas 1/2/3 — independent setInterval cleaned up
    // in finally.
    if (ctx.opts.deepThink && ctx.bridge?.runPreThink) {
      const PRE_THINK_HEARTBEAT_MS =
        Number(process.env.CODER_PRE_THINK_HEARTBEAT_MS ?? '10000') || 10_000;
      const preThinkStartedAt = Date.now();
      const preThinkOpId = `pre-think:${ctx.runId}:${ctx.turn}`;
      let preThinkFinished = false;
      ctx.operations.start({
        opId: preThinkOpId,
        kind: 'provider',
        label: 'pre-think',
        phase: 'awaiting_aux_provider',
      });
      const preThinkHeartbeat = setInterval(() => {
        ctx.operations.progress(preThinkOpId, {
          phase: 'awaiting_aux_provider',
          note: 'resolving aux provider / awaiting reasoning',
        });
        ctx.emit('tool_progress', {
          id: preThinkOpId,
          name: 'pre-think',
          elapsedMs: Date.now() - preThinkStartedAt,
          note: 'resolving aux provider / awaiting reasoning…',
        });
      }, PRE_THINK_HEARTBEAT_MS);
      try {
        // A1 — race against user-abort signal. The bridge's internal
        // timeouts (resolveAuxProvider 15s, runPreThink 8s) protect the
        // happy path; this protects the user-cancellation path.
        const pre = await withAbort(
          ctx.bridge.runPreThink({
            messages: messagesForChat,
            toolNames: toolsBuilt.tools.map((t) => t.name),
            turn: ctx.turn,
          }),
          ctx.opts.toolContext.signal,
        );
        if (pre?.text) {
          const auxModel = ctx.opts.deepThinkModel ?? 'claude-haiku-4-5-20251001';
          const preThinkBlock: ContentBlock = {
            type: 'text',
            text: `<thinking data-source="aux" data-model="${auxModel}">\n${pre.text}\n</thinking>\n\n`,
          };
          messagesForChat.push({ role: 'assistant', content: [preThinkBlock] });
          accumulateUsage(ctx, pre.usage ?? null);

          // Persist into the durable history so the dashboard renders the
          // emerald `<thinking data-source="aux">` block in the transcript
          // AND so future turns/resumes see the accumulated reasoning.
          if (ctx.opts.persistPreThoughts !== false) {
            const persistMsg = { role: 'assistant' as const, content: [preThinkBlock] };
            ctx.messages.push(persistMsg);
            const store = ctx.opts.sessionStore;
            if (store && ctx.opts.sessionId !== undefined) {
              try {
                store.appendMessage(ctx.opts.sessionId, persistMsg);
              } catch (e) {
                dbg('pre-think persistence failed', e);
              }
            }
          }
        }
      } catch (e) {
        if (isAbortError(e)) {
          // Honour the user-abort cleanly — short-circuit the whole turn.
          clearInterval(preThinkHeartbeat);
          preThinkFinished = true;
          ctx.operations.finish(preThinkOpId, 'aborted', { phase: 'aborted', note: 'user/session aborted' });
          ctx.aborted = true;
          ctx.stopReason = 'aborted';
          return events.aborted();
        }
        preThinkFinished = true;
        ctx.operations.finish(preThinkOpId, 'failed', {
          phase: 'failed',
          note: e instanceof Error ? e.message : String(e),
        });
        dbg('runPreThink threw', e);
      } finally {
        clearInterval(preThinkHeartbeat);
        if (!preThinkFinished) {
          preThinkFinished = true;
          ctx.operations.finish(preThinkOpId, 'completed', { phase: 'completed' });
        }
      }
    }

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

    let stream: AsyncIterable<ChatDelta>;
    try {
      dbg(`calling provider.chat() model=${ctx.opts.provider.model}`);
      ctx.operations.progress(providerOpId, { phase: 'provider.chat' });
      stream = ctx.opts.provider.chat({
        system: systemPrompt,
        messages: messagesForChat,
        tools: toolsBuilt.tools,
        thinking: ctx.opts.thinking,
        thinkingBudgetTokens: ctx.opts.thinkingBudgetTokens,
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
    const toolsDefChars = (() => {
      try { return JSON.stringify(toolsBuilt.tools).length; } catch { return 0; }
    })();
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

    // Dashboard telemetry — preview the batch before dispatch so the UI
    // can render the pending tool list immediately (legacy parity).
    ctx.emit('tool_batch', {
      runId: ctx.runId,
      turn: ctx.turn,
      count: result.toolUses.length,
      names: result.toolUses.map((t) => t.name),
    });

    if (result.toolUses.length === 0) {
      // Text-only assistant turn ends the run — no tool_use means the
      // model is delivering its final reply.
      runQualityCheck(ctx, joinText(result.textBlocks), [], result.toolUses);
      runPersistTelemetry([]);
      ctx.stopReason = 'completed';
      return events.cleanFinish();
    }

    const dispatch = await dispatchTools({
      toolUses: result.toolUses,
      registry: ctx.opts.registry,
      toolContext: ctx.opts.toolContext,
      turn: ctx.turn,
      dupCalls: ctx.dupCalls,
      loopRefusals: ctx.loopRefusals,
      toolGate: ctx.bridge?.toolGate,
      enforcePreRead: ctx.bridge?.enforcePreRead,
      enforceTaskMode: ctx.bridge?.enforceTaskMode,
      reduceToolResult: ctx.bridge?.reduceToolResult,
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
    for (const r of dispatch.results) {
      ctx.operations.finish(`tool:${r.toolUseId}`, r.isError ? 'failed' : 'completed', {
        phase: r.isError ? 'failed' : 'completed',
      });
      ctx.emit(
        'tool_call_result',
        r.toolUseId,
        r.name,
        { content: r.content, isError: r.isError },
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

    if (dispatch.toolLoopDetected) {
      return events.toolLoopDetected({ guard: dispatch.loopGuard ?? 'tuple-hash' });
    }

    if (result.usage?.input_tokens) {
      // PR-F BodyAfterPrefix gate. The legacy `shouldCompact90` (Frente B,
      // ratio 0.75) treats system+tools as growth axes alongside body. For
      // providers that cache the prefix (Anthropic + cache header, OpenAI
      // prefix caching), the body alone bears the real variance — so the
      // BodyAfterPrefix gate, using body capacity (effective − prefix), is
      // strictly more accurate.
      //
      // Both gates fire on the SAME post-response token count; we OR them
      // so we get earliest possible trigger. This is intentional: the
      // BodyAfterPrefix gate uses a higher ratio (0.85) on a smaller
      // capacity, which sometimes fires AFTER shouldCompact90 — and vice
      // versa, depending on the prefix:body ratio. Or-ing covers both.
      const bodyDecision = shouldCompactBodyAfterPrefix({
        promptTokens: result.usage.input_tokens,
        prefixTokens: prefixTokensEstimate,
        model: ctx.opts.provider.model,
      });
      const totalDecision = shouldCompact90({
        promptTokens: result.usage.input_tokens,
        model: ctx.opts.provider.model,
      });
      if (bodyDecision.shouldCompact || totalDecision.shouldCompact) {
        dbg(
          `post-response gate fired: body.shouldCompact=${bodyDecision.shouldCompact} ` +
          `(ratio=${bodyDecision.ratio.toFixed(3)}) total.shouldCompact=${totalDecision.shouldCompact} ` +
          `(ratio=${totalDecision.ratio.toFixed(3)})`,
        );
        // Prefer the higher ratio for the event payload (it's the binding
        // constraint that triggered the fire).
        const ratio = Math.max(bodyDecision.ratio, totalDecision.ratio);
        return events.tokenThresholdHit({ ratio });
      }
    }

    return decideTerminal(ctx);
  }
}
