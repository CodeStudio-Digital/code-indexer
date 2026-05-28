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
import { shouldCompact90 } from '../compaction/threshold.js';
import { consumeStream } from './executing-stream.js';
import { dispatchTools, buildToolMessage } from './executing-dispatch.js';
import {
  decideTerminal,
  runQualityCheck,
  joinText,
  providerErrorEvent,
} from './executing-decisions.js';

const DEBUG = process.env.CODER_BT_DEBUG === '1';
function dbg(...args: unknown[]): void {
  if (DEBUG) console.log('[bt-debug]', ...args);
}

export class ExecutingNode implements BehaviorNode {
  readonly state = 'Executing' as const;

  async execute(ctx: RunContext, _lastEvent: BehaviorEvent | null): Promise<BehaviorEvent> {
    ctx.turn++;
    ctx.emit('turn_start', ctx.turn);
    dbg(`Executing turn=${ctx.turn} messages=${ctx.messages.length}`);

    const tunables = ctx.opts.tunables ?? envTunables();
    const messagesForChat = assembleMessagesForChat({
      messages: ctx.messages,
      tunables,
      compactionLimits: undefined,
      preThinkHistoryWindow: ctx.opts.preThinkHistoryWindow ?? 3,
      persistPreThoughts: ctx.opts.persistPreThoughts !== false,
      agentLoopV2: !!ctx.opts.agentLoopV2,
      buildActiveSkillsBlock: ctx.bridge?.buildActiveSkillsBlock ?? (() => null),
      buildActiveContextBlock: ctx.bridge?.buildActiveContextBlock ?? (() => null),
    });

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
      const preThinkHeartbeat = setInterval(() => {
        ctx.emit('tool_progress', {
          id: `pre-think:${ctx.runId}:${ctx.turn}`,
          name: 'pre-think',
          elapsedMs: Date.now() - preThinkStartedAt,
          note: 'resolving aux provider / awaiting reasoning…',
        });
      }, PRE_THINK_HEARTBEAT_MS);
      try {
        const pre = await ctx.bridge.runPreThink({
          messages: messagesForChat,
          toolNames: toolsBuilt.tools.map((t) => t.name),
          turn: ctx.turn,
        });
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
        dbg('runPreThink threw', e);
      } finally {
        clearInterval(preThinkHeartbeat);
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

    let stream: AsyncIterable<ChatDelta>;
    try {
      dbg(`calling provider.chat() model=${ctx.opts.provider.model}`);
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
      ctx.emit('tool_progress', {
        id: `provider-chat:${ctx.runId}:${ctx.turn}`,
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
        onTextDelta: (text) => ctx.emit('text_delta', text),
        onThinkingDelta: (text) => ctx.emit('thinking_delta', text),
      });
    } catch (e) {
      dbg('consumeStream threw', e);
      return providerErrorEvent(e);
    } finally {
      clearInterval(streamHeartbeat);
    }
    dbg(`stream done text=${result.textBlocks.length}b tools=${result.toolUses.length} usage_in=${result.usage?.input_tokens ?? '?'}`);

    accumulateUsage(ctx, result.usage);

    if (result.responseId !== null && result.responseMessageCount !== null) {
      ctx.bridge?.onResponseId?.(result.responseId, result.responseMessageCount);
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
      ctx.stopReason = 'completed';
      return events.cleanFinish();
    }

    const dispatch = await dispatchTools({
      toolUses: result.toolUses,
      registry: ctx.opts.registry,
      toolContext: ctx.opts.toolContext,
      turn: ctx.turn,
      dupCalls: ctx.dupCalls,
      toolGate: ctx.bridge?.toolGate,
      enforcePreRead: ctx.bridge?.enforcePreRead,
      enforceTaskMode: ctx.bridge?.enforceTaskMode,
      reduceToolResult: ctx.bridge?.reduceToolResult,
      detectPollingStuck: ctx.bridge?.detectPollingStuck,
      onToolCallStart: (id, name, input) => ctx.emit('tool_call_start', id, name, input),
      onToolCallFinalized: (id, shapedChars) =>
        ctx.emit('tool_call_finalized', id, { shapedChars }),
      onToolProgress: (id, name, elapsedMs) =>
        ctx.emit('tool_progress', { id, name, elapsedMs }),
    });

    ctx.messages.push(buildToolMessage(dispatch.results));
    for (const r of dispatch.results) {
      ctx.emit(
        'tool_call_result',
        r.toolUseId,
        r.name,
        { content: r.content, isError: r.isError },
        r.durationMs,
      );
    }

    // Fire-and-forget quality classifier. Errors must NOT block the turn.
    runQualityCheck(ctx, joinText(result.textBlocks), dispatch.results, result.toolUses);

    if (dispatch.toolLoopDetected) {
      return events.toolLoopDetected({ guard: 'tuple-hash' });
    }

    if (result.usage?.input_tokens) {
      const decision = shouldCompact90({
        promptTokens: result.usage.input_tokens,
        model: ctx.opts.provider.model,
      });
      if (decision.shouldCompact) {
        return events.tokenThresholdHit({ ratio: decision.ratio });
      }
    }

    return decideTerminal(ctx);
  }
}

