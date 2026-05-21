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
import type { ResolveContext } from '../pipelines/index.js';
import type { PipelineProviderResolver } from '../pipelines/provider-resolver.js';
import {
  type ChatCallOptions,
  type ChatMessage,
} from './llm-chat.js';
import { pickChatFn } from './chat-dispatcher.js';
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
  ) => Promise<{ content: string; errorBody?: string; latencyMs: number }>;
}

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
  protected parseVerdict(text: string): { verdict: QualityVerdict; confidence?: number; reason?: string } {
    const json = tryParseJson(text);
    if (!json || typeof json !== 'object') {
      return { verdict: 'error', reason: 'unparseable response' };
    }
    const verdict = (json as { verdict?: unknown }).verdict;
    const confidence = (json as { confidence?: unknown }).confidence;
    const reason = (json as { reason?: unknown }).reason;
    if (!isQualityVerdict(verdict)) {
      return { verdict: 'error', reason: `bad verdict field: ${String(verdict)}` };
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
    const binding = await this.resolver.resolveOrNull(this.pipelineName, this.bindingRole, ctx);
    if (!binding) {
      return {
        classifierName: this.classifierName,
        verdict: 'error',
        reason: 'no provider binding configured',
        latencyMs: performance.now() - startedAt,
      };
    }

    const messages: ChatMessage[] = [
      { role: 'system', content: this.systemPrompt() },
      { role: 'user',   content: this.buildUserPrompt(output) },
    ];
    const chat = this.options.chatFn ?? pickChatFn(binding);
    const result = await chat(binding, messages);
    if (result.errorBody) {
      return {
        classifierName: this.classifierName,
        verdict: 'error',
        reason: result.errorBody.slice(0, 500),
        latencyMs: result.latencyMs,
        providerId: binding.provider.id,
        modelId: binding.modelId,
      };
    }
    const parsed = this.parseVerdict(result.content);
    return {
      classifierName: this.classifierName,
      verdict: parsed.verdict,
      confidence: parsed.confidence,
      reason: parsed.reason,
      latencyMs: result.latencyMs,
      providerId: binding.provider.id,
      modelId: binding.modelId,
      raw: result.content,
    };
  }
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
