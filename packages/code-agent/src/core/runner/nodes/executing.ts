/**
 * Executing node — drives ONE full provider turn.
 *
 * Pipeline:
 *   1. bump `ctx.turn` and emit `turn_start`.
 *   2. assemble messages (via assembly + bridge callbacks for skills /
 *      active-context).
 *   3. build tools (via assembly).
 *   4. assemble the system prompt (base + quality-feedback suffix from
 *      bridge).
 *   5. stream `provider.chat()` with every parameter the legacy passes
 *      (thinking, sessionId, previousResponseId, inference.temperature).
 *   6. push the assistant message.
 *   7. dispatch tools via tuple-hash guard + bridge.toolGate.
 *   8. push tool-role message, decide next event:
 *        - any dedup refusal     → ToolLoopDetected (→ Planning)
 *        - token usage ≥ 90% eff → TokenThresholdHit (→ Compacting)
 *        - assistant text only   → CleanFinish
 *        - otherwise             → TurnSucceeded
 *
 * The bridge (`ctx.bridge`) is how the BT inherits behavior still owned
 * by the legacy `CoderRunner`: skills, active-context, plan/spec gates,
 * Responses-API state, temperature resolution, quality-feedback suffix.
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

// Until the BT migration stabilises in production, log key checkpoints
// unconditionally so a hang in `provider.chat()` or `consumeStream` is
// visible in the worker terminal without enabling `CODER_BT_DEBUG`.
const QUIET = process.env.CODER_BT_QUIET === '1';
function dbg(...args: unknown[]): void {
  if (QUIET) return;
  console.log('[coder/bt]', ...args);
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

    const tempResolution = ctx.bridge?.resolveTemperature?.();
    const prevResponse = ctx.bridge?.getPreviousResponseId?.();

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
      dbg(`provider.chat() threw`, e);
      return providerErrorEvent(e);
    }

    let result: Awaited<ReturnType<typeof consumeStream>>;
    try {
      result = await consumeStream({
        stream,
        signal: ctx.opts.toolContext.signal,
        onTextDelta: (text) => ctx.emit('text_delta', text),
        onThinkingDelta: (text) => ctx.emit('thinking_delta', text),
      });
    } catch (e) {
      dbg(`consumeStream threw`, e);
      return providerErrorEvent(e);
    }
    dbg(`stream done text=${result.textBlocks.length}b tools=${result.toolUses.length} usage_in=${result.usage?.input_tokens ?? '?'}`);

    accumulateUsage(ctx, result.usage);

    if (result.responseId !== null && result.responseMessageCount !== null) {
      ctx.bridge?.onResponseId?.(result.responseId, result.responseMessageCount);
    }

    const assistantContent: ContentBlock[] = [];
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

    if (result.toolUses.length === 0) {
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

    return events.turnSucceeded({ hasToolCalls: true });
  }
}

function providerErrorEvent(e: unknown): BehaviorEvent {
  const status = inferStatus(e);
  return events.providerError({
    retryable: status >= 500 || status === 429 || status === 401,
    status,
  });
}

function inferStatus(e: unknown): number {
  if (e && typeof e === 'object') {
    const s = (e as { status?: number }).status;
    if (typeof s === 'number') return s;
  }
  return 500;
}
