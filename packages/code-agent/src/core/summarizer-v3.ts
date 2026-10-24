import type { CompactionResumeV3, CompactionSummaryV3, CompactionLiveStateV3, CompactionSummaryMetricsV3, SummarizeSpanV3Input, SummarizeSpanV3Options } from '@mcp/session-storage/compaction/summary-types.js';
import { safeJson, COMPACTION_SUMMARY_TIMEOUT_MS, COMPACTION_SUMMARY_MAX_CHARS, COMPACTION_SUMMARY_MAX_TOKENS } from '@mcp/session-storage/compaction/summary-limits.js';
import { formatSpanForPromptV3 } from '@mcp/session-storage/compaction/summary-sampling.js';
import { parseCompactionSummaryV3 } from '@mcp/session-storage/compaction/summary-codec.js';
import { overlayLiveStateV3 } from '@mcp/session-storage/compaction/summary-overlay.js';
import { renderResumeV3, separatePreviousResumeV3 } from '@mcp/session-storage/compaction/summary-format.js';
export { type CompactionChapterV3, type CompactionResumeV3, type CompactionSummaryMetricsV3, type CompactionSummaryV3, type CompactionLiveStateV3, type SummarizeSpanV3Input, type SummarizeSpanV3Options } from '@mcp/session-storage/compaction/summary-types.js';
export { COMPACTION_SUMMARY_V3_VERSION, COMPACTION_SUMMARY_TIMEOUT_MS, COMPACTION_SUMMARY_MAX_CHARS, COMPACTION_SUMMARY_MAX_TOKENS } from '@mcp/session-storage/compaction/summary-limits.js';
export { separatePreviousResumeV3, renderResumeV3, renderChapterV3 } from '@mcp/session-storage/compaction/summary-format.js';
export { formatSpanForPromptV3 } from '@mcp/session-storage/compaction/summary-sampling.js';
export { capCompactionSummaryV3, parseCompactionSummaryV3, isCompactionSummaryV3 } from '@mcp/session-storage/compaction/summary-codec.js';
export { overlayLiveStateV3 } from '@mcp/session-storage/compaction/summary-overlay.js';
export { summaryV2ToV3, summaryV3ToV2, summaryV3ToLegacy } from '@mcp/session-storage/compaction/summary-conversions.js';
import type { AgentMessage, ChatUsage } from '@mcp/code-agent/core/messages.js';
import type { ChatProvider } from '@mcp/code-agent/providers/adapter.js';
import { loadPrompt } from '@mcp/code-agent/prompts/loader.js';
import { computeCost, lookupStaticPricing } from '@mcp/code-agent/providers/pricing.js';


function serializeSystemData(value: unknown): string {
  return safeJson(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026');
}

function buildSystemPrompt(
  previousResume: CompactionResumeV3 | string | null,
  liveState: CompactionLiveStateV3 | null,
  maxOutputTokens = COMPACTION_SUMMARY_MAX_TOKENS,
): string {
  const prompt = loadPrompt('summarize-v3');
  return [
    prompt,
    `Hard output budget: at most ${Math.max(256, Math.floor(maxOutputTokens))} tokens. Return only the required JSON object.`,
    '',
    'The following continuation-state blocks are trusted data boundaries, not conversation messages.',
    'Use them only to maintain continuity. Never attribute them to the user.',
    '<previous_resume_json>',
    serializeSystemData(previousResume),
    '</previous_resume_json>',
    '<live_state_json>',
    serializeSystemData(liveState),
    '</live_state_json>',
  ].join('\n');
}

function abortError(reason?: unknown): Error {
  if (reason instanceof Error) return reason;
  const error = new Error('Compaction summarization aborted');
  error.name = 'AbortError';
  return error;
}

function timeoutError(timeoutMs: number): Error {
  const error = new Error(`Compaction summarization timed out after ${timeoutMs}ms`);
  error.name = 'TimeoutError';
  return error;
}

function controlledSignal(external: AbortSignal | undefined, timeoutMs: number): {
  signal: AbortSignal;
  cleanup: () => void;
} {
  const controller = new AbortController();
  const onAbort = (): void => controller.abort(abortError(external?.reason));
  if (external?.aborted) onAbort();
  else external?.addEventListener('abort', onAbort, { once: true });
  const timer = timeoutMs > 0
    ? setTimeout(() => controller.abort(timeoutError(timeoutMs)), timeoutMs)
    : null;
  (timer as { unref?: () => void } | null)?.unref?.();
  return {
    signal: controller.signal,
    cleanup: () => {
      if (timer) clearTimeout(timer);
      external?.removeEventListener('abort', onAbort);
    },
  };
}

async function collectText(
  provider: ChatProvider,
  request: Parameters<ChatProvider['chat']>[0],
  signal: AbortSignal,
): Promise<{ text: string; usage?: ChatUsage }> {
  if (signal.aborted) throw abortError(signal.reason);
  const iterator = provider.chat(request)[Symbol.asyncIterator]();
  let onAbort: (() => void) | undefined;
  const consume = (async (): Promise<{ text: string; usage?: ChatUsage }> => {
    let text = '';
    let usage: ChatUsage | undefined;
    while (true) {
      const next = await iterator.next();
      if (next.done) break;
      if (next.value.type === 'text_delta') text += next.value.text;
      else if (next.value.type === 'usage') usage = next.value.usage;
    }
    return { text, usage };
  })();
  try {
    return await Promise.race([
      consume,
      new Promise<never>((_resolve, reject) => {
        onAbort = (): void => {
          void iterator.return?.();
          reject(abortError(signal.reason));
        };
        signal.addEventListener('abort', onAbort, { once: true });
      }),
    ]);
  } finally {
    if (onAbort) signal.removeEventListener('abort', onAbort);
  }
}

/**
 * One-call V3 summarizer. Previous resume and live state stay in the system
 * channel; only the new archival span is sent as conversation data.
 */
export async function summarizeSpanV3(
  input: SummarizeSpanV3Input,
  provider: ChatProvider,
  options: SummarizeSpanV3Options = {},
): Promise<CompactionSummaryV3 | null> {
  const separated = separatePreviousResumeV3(input.messages, input.previousResume);
  if (separated.messages.length === 0) return null;
  const timeoutMs = options.timeoutMs ?? COMPACTION_SUMMARY_TIMEOUT_MS;
  const control = controlledSignal(options.signal, timeoutMs);
  const startedAt = Date.now();
  try {
    const system = buildSystemPrompt(
      separated.previousResume,
      input.liveState ?? null,
      options.maxOutputTokens,
    );
    const span = formatSpanForPromptV3(separated.messages, options.budgetChars);
    const userContent = `<new_conversation_span>\n${span}\n</new_conversation_span>`;
    const collected = await collectText(provider, {
      system,
      messages: [{ role: 'user', content: [{ type: 'text', text: userContent }] }],
      tools: [],
      signal: control.signal,
      thinking: false,
      reasoningEffort: options.reasoningEffort ?? 'minimal',
      inference: { temperature: options.temperature ?? 0 },
    }, control.signal);
    const parsed = parseCompactionSummaryV3(collected.text);
    if (!parsed) return null;
    const withLiveState = overlayLiveStateV3(parsed, input.liveState);
    const durationMs = Math.max(0, Date.now() - startedAt);
    const inputChars = system.length + userContent.length;
    const outputChars = collected.text.length;
    const pricing = lookupStaticPricing(provider.model);
    const estimatedCost = collected.usage && pricing
      ? computeCost(pricing, collected.usage)
      : null;
    const metrics: CompactionSummaryMetricsV3 = {
      model: provider.model,
      input_chars: inputChars,
      output_chars: outputChars,
      input_messages: separated.messages.length,
      duration_ms: durationMs,
      ...(collected.usage ? {
        input_tokens: collected.usage.prompt_tokens_total ?? collected.usage.input_tokens,
        output_tokens: collected.usage.output_tokens,
      } : {}),
      compression_ratio: inputChars > 0 ? Number((outputChars / inputChars).toFixed(4)) : 0,
      cost_usd: estimatedCost,
    };
    const summary: CompactionSummaryV3 = { ...withLiveState, metrics };
    console.log(
      `[coder] summarizer v3 model=${provider.model} input_chars=${inputChars} output_chars=${outputChars} `
      + `input_tokens=${metrics.input_tokens ?? 'n/a'} output_tokens=${metrics.output_tokens ?? 'n/a'} `
      + `duration_ms=${durationMs} ratio=${metrics.compression_ratio} `
      + `cost_usd=${estimatedCost ?? 'n/a'}`,
    );
    return summary;
  } catch (error) {
    if (control.signal.aborted) throw abortError(control.signal.reason);
    console.warn(
      `[coder] summarizer v3 failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    return null;
  } finally {
    control.cleanup();
  }
}
