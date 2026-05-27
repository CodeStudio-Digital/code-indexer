/**
 * Executing node — drives ONE full provider turn.
 *
 * Pipeline:
 *   1. bump `ctx.turn` and emit `turn_start`.
 *   2. assemble messages + tools via the modules from Commit 2.
 *   3. stream `provider.chat()` and accumulate text + tool_use blocks.
 *   4. push the assistant message into `ctx.messages`.
 *   5. if the assistant emitted no tool calls → CleanFinish.
 *   6. otherwise dispatch each tool_use via the tuple-hash guard.
 *   7. push the tool-role message with the results.
 *   8. emit per-tool telemetry, then decide the next event:
 *        - any dedup refusal     → ToolLoopDetected (→ Planning)
 *        - token usage ≥ 90% eff → TokenThresholdHit (→ Compacting)
 *        - otherwise             → TurnSucceeded (→ Executing again)
 *
 * Out of scope (deferred to Commit 7):
 *   - Plan/spec gating, polling-stuck caps, dominance guard, quality
 *     watchdog, deep-think pre-think, pre-read enforcement, smart-reducer
 *     post-result, push-time truncation. The legacy `runner.ts` while-loop
 *     keeps doing all of that while CODER_BT_ENABLED is opt-in.
 */
import type { BehaviorEvent, BehaviorNode, RunContext } from '../machine/types.js';
import type { ContentBlock } from '@mcp/code-agent/core/messages.js';
import { events } from '../machine/events.js';
import { accumulateUsage } from '../machine/context.js';
import { envTunables } from '@mcp/code-agent/core/tunables.js';
import { assembleMessagesForChat } from '../assembly/messages.js';
import { buildTools } from '../assembly/tools.js';
import { shouldCompact90 } from '../compaction/threshold.js';
import { consumeStream } from './executing-stream.js';
import { dispatchTools, buildToolMessage } from './executing-dispatch.js';

export class ExecutingNode implements BehaviorNode {
  readonly state = 'Executing' as const;

  async execute(ctx: RunContext, _lastEvent: BehaviorEvent | null): Promise<BehaviorEvent> {
    ctx.turn++;
    ctx.emit('turn_start', ctx.turn);

    const tunables = ctx.opts.tunables ?? envTunables();
    const messagesForChat = assembleMessagesForChat({
      messages: ctx.messages,
      tunables,
      compactionLimits: undefined,
      preThinkHistoryWindow: ctx.opts.preThinkHistoryWindow ?? 3,
      persistPreThoughts: ctx.opts.persistPreThoughts !== false,
      agentLoopV2: !!ctx.opts.agentLoopV2,
      buildActiveSkillsBlock: () => null,
      buildActiveContextBlock: () => null,
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

    let stream: AsyncIterable<import('@mcp/code-agent/core/messages.js').ChatDelta>;
    try {
      stream = ctx.opts.provider.chat({
        system: ctx.opts.systemPrompt,
        messages: messagesForChat,
        tools: toolsBuilt.tools,
      });
    } catch (e) {
      return providerErrorEvent(e);
    }

    let result: Awaited<ReturnType<typeof consumeStream>>;
    try {
      result = await consumeStream({
        stream,
        onTextDelta: (text) => ctx.emit('text_delta', text),
        onThinkingDelta: (text) => ctx.emit('thinking_delta', text),
      });
    } catch (e) {
      return providerErrorEvent(e);
    }

    accumulateUsage(ctx, result.usage);

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
