/**
 * LLMClassifier — base class for the 5 single-task classifiers.
 *
 * Each concrete classifier supplies:
 *   - `classifierName`: stable key written to quality_classifications
 *   - `pipelineName`: matches the PIPELINE_CATALOG entry (`quality_off_topic` etc.)
 *   - `bindingRole`: always 'classifier'
 *   - `systemPrompt`: short instructions for the model
 *   - `buildUserPrompt(output)`: takes the agent output, returns user text
 *   - `parseVerdict(text)`: turns the model's reply into ClassificationVerdict
 *
 * The base handles: provider resolution, chat call, error fallback, latency
 * tracking, and writing to QualityClassificationStore.
 *
 * Inspired by `grox/classifiers/content/classifier.py` — small specialized
 * classifiers that all share the same observability scaffolding.
 */
import type { ResolveContext, ResolvedBinding } from '../pipelines/index.js';
import type { PipelineProviderResolver } from '../pipelines/provider-resolver.js';
import {
  type ChatCallOptions,
  type ChatCallResult,
  type ChatMessage,
} from './llm-chat.js';
import { pickChatFn } from './chat-dispatcher.js';
import {
  type ChatRetryOptions,
  errorKindFromChatResult,
} from './chat-retry.js';
import { callChatWithFailover } from './binding-failover.js';
import type {
  AgentOutputForClassification,
  ClassificationVerdict,
  QualityVerdict,
} from './types.js';

export interface LLMClassifierOptions {
  /** Override the chat call (used by tests). */
  chatFn?: (
    binding: import('../pipelines/index.js').ResolvedBinding,
    messages: ChatMessage[],
    options?: ChatCallOptions,
  ) => Promise<ChatCallResult>;
  /** Retry policy for the chat call. Defaults to 2 retries on the
   *  rate-limit family. Pass `{ maxRetries: 0 }` to disable. */
  retry?: ChatRetryOptions;
}

/**
 * Classifier-specific defaults. A single-task classification needs a tiny
 * JSON reply, so we cap tokens low and time out sooner than the generic
 * 30s — a fast classifier model answers in well under a second, and a
 * shorter ceiling means a hung request fails fast instead of burning 30s.
 * Operator config (`config_json.timeout` / `.max_tokens` in the Pipelines
 * tab) still wins when set.
 */
const CLASSIFIER_DEFAULT_TIMEOUT_MS = 15_000;
const CLASSIFIER_DEFAULT_MAX_TOKENS = 1024;

export abstract class LLMClassifier {
  abstract readonly classifierName: string;
  abstract readonly pipelineName: string;
  readonly bindingRole = 'classifier';

  constructor(
    protected resolver: PipelineProviderResolver,
    protected options: LLMClassifierOptions = {},
  ) {}

  /** Concrete classifiers implement these two. */
  protected abstract systemPrompt(): string;
  protected abstract buildUserPrompt(output: AgentOutputForClassification): string;

  /**
   * Parse the model's free-text reply into a structured verdict. Default
   * implementation expects a strict JSON object — subclasses can override
   * for non-JSON parsing.
   */
  protected parseVerdict(text: string): { verdict: QualityVerdict; systemError?: boolean; confidence?: number; reason?: string } {
    const json = tryParseJson(text);
    if (!json || typeof json !== 'object') {
      return { verdict: 'error', systemError: true, reason: 'unparseable response' };
    }
    const verdict = (json as { verdict?: unknown }).verdict;
    const confidence = (json as { confidence?: unknown }).confidence;
    const reason = (json as { reason?: unknown }).reason;
    if (!isQualityVerdict(verdict)) {
      return { verdict: 'error', systemError: true, reason: `bad verdict field: ${String(verdict)}` };
    }
    return {
      verdict,
      confidence: typeof confidence === 'number' ? Math.max(0, Math.min(1, confidence)) : undefined,
      reason: typeof reason === 'string' ? reason.slice(0, 1000) : undefined,
    };
  }

  /** Build the resolveContext from the output. Override if needed. */
  protected resolveContext(output: AgentOutputForClassification): ResolveContext {
    return {
      sessionId: output.sessionId ?? undefined,
      companySessionId: output.companySessionId ?? undefined,
    };
  }

  /** Public entry point — called by the pipeline. */
  async classify(output: AgentOutputForClassification): Promise<ClassificationVerdict> {
    const startedAt = performance.now();
    const ctx = this.resolveContext(output);
    // Resolve the full failover chain: if the highest-priority binding is
    // broken at runtime (dead key, provider down), the next enabled binding
    // for this pipeline/role serves instead of returning verdict:'error'.
    const chain = await this.resolver.resolveChain(this.pipelineName, this.bindingRole, ctx);
    if (chain.length === 0) {
      return {
        classifierName: this.classifierName,
        verdict: 'error',
        systemError: true,
        reason: '[no_binding] no provider binding configured',
        latencyMs: performance.now() - startedAt,
      };
    }

    const messages: ChatMessage[] = [
      { role: 'system', content: this.systemPrompt() },
      { role: 'user',   content: this.buildUserPrompt(output) },
    ];
    // Each binding carries its OWN config (timeout / max_tokens), so build the
    // chat options per attempt rather than once from the top binding.
    const runOne = (binding: ResolvedBinding): Promise<ChatCallResult> => {
      const cfg = binding.config as Record<string, unknown>;
      const chatOptions: ChatCallOptions = {
        timeoutMs: toNumber(cfg.timeout) ?? CLASSIFIER_DEFAULT_TIMEOUT_MS,
        maxTokens: toNumber(cfg.max_tokens) ?? CLASSIFIER_DEFAULT_MAX_TOKENS,
      };
      const chat = this.options.chatFn ?? pickChatFn(binding);
      return chat(binding, messages, chatOptions);
    };
    const { result, binding, failedOver } = await callChatWithFailover(chain, runOne, {
      retry: this.options.retry,
      label: `${this.pipelineName} classifier`,
      codePrefix: this.pipelineName,
    });
    const providerId = binding?.provider.id;
    const modelId = binding?.modelId;
    const failoverTag = failedOver ? '[failover] ' : '';
    if (result.errorBody) {
      return {
        classifierName: this.classifierName,
        verdict: 'error',
        systemError: true,
        reason: `${failoverTag}[${errorKindFromChatResult(result)}] ${result.errorBody.slice(0, 480)}`,
        latencyMs: result.latencyMs,
        providerId,
        modelId,
      };
    }
    const parsed = this.parseVerdict(result.content);
    // Tag unparseable replies so the dashboard distinguishes a model
    // formatting failure (systemError) from a content verdict of 'error'.
    const baseReason = parsed.systemError && parsed.reason ? `[parse] ${parsed.reason}` : parsed.reason;
    return {
      classifierName: this.classifierName,
      verdict: parsed.verdict,
      systemError: parsed.systemError,
      confidence: parsed.confidence,
      reason: failedOver ? `${failoverTag}${baseReason ?? 'served by fallback binding'}` : baseReason,
      latencyMs: result.latencyMs,
      providerId,
      modelId,
      raw: result.content,
    };
  }
}

function toNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  return undefined;
}

/**
 * Tolerant JSON extractor for classifier responses.
 *
 * Real-world LLMs return JSON wrapped in all kinds of cruft:
 *   - Markdown ```json fences
 *   - `<think>...</think>` reasoning blocks (GLM-5, DeepSeek-R1, etc.)
 *   - Preamble prose ("Here's my analysis: {...}")
 *   - Trailing prose ("{...} Hope this helps!")
 *   - Smart quotes from markdown rendering
 *   - Trailing commas (looser-than-strict JSON)
 *
 * Strategy: 4-pass attempt, each falling back to the next:
 *   1. Strip <think> blocks + markdown fences → strict JSON.parse
 *   2. Find FIRST `{` and the matching `}` via brace counting → parse the
 *      substring. Handles "Here's the JSON: {...}".
 *   3. Try removing trailing commas (`,}` and `,]`) before parsing.
 *   4. Give up — return null. Caller surfaces 'unparseable response'.
 */
function tryParseJson(text: string): unknown {
  // Strip <think>...</think> blocks (reasoning models leak these).
  // Be defensive: greedy is fine because <think> blocks shouldn't nest.
  let cleaned = text.replace(/<think[\s\S]*?<\/think>/gi, '').trim();
  // Markdown fences.
  cleaned = cleaned
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```\s*$/, '');
  // Pass 1: strict parse on the cleaned text.
  const direct = safeJsonParse(cleaned);
  if (direct !== null) return direct;

  // Pass 2: extract the first balanced { ... } substring.
  const extracted = extractFirstJsonObject(cleaned);
  if (extracted) {
    const parsed = safeJsonParse(extracted);
    if (parsed !== null) return parsed;
    // Pass 3: forgiveness for trailing commas.
    const noTrailing = extracted.replace(/,(\s*[}\]])/g, '$1');
    const reparsed = safeJsonParse(noTrailing);
    if (reparsed !== null) return reparsed;
  }
  return null;
}

function safeJsonParse(s: string): unknown {
  try { return JSON.parse(s); } catch { return null; }
}

/**
 * Walks `text` to find the first balanced `{...}` block. Returns the
 * substring (inclusive of braces) or null if no balanced object exists.
 * Respects string literals so braces inside strings don't confuse the
 * counter.
 */
function extractFirstJsonObject(text: string): string | null {
  const start = text.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let stringQuote: '"' | "'" | null = null;
  let escape = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escape) { escape = false; continue; }
      if (ch === '\\') { escape = true; continue; }
      if (ch === stringQuote) { inString = false; stringQuote = null; }
      continue;
    }
    if (ch === '"' || ch === "'") {
      inString = true;
      stringQuote = ch as '"' | "'";
      continue;
    }
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

const VERDICT_VALUES: QualityVerdict[] = ['ok', 'warn', 'flagged', 'error'];

function isQualityVerdict(v: unknown): v is QualityVerdict {
  return typeof v === 'string' && (VERDICT_VALUES as string[]).includes(v);
}
