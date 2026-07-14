/**
 * Native fill-in-the-middle (FIM) completion for editor autocomplete.
 *
 * Code models with a native completions endpoint (DeepSeek `/beta/completions`,
 * qwen2.5-coder, codestral, starcoder) take a raw `prompt` + `suffix` and
 * return the insertion directly — faster than chat and with NONE of the fence/
 * prefix-echo scrubbing the chat path fights. The layered project context is
 * passed as a leading comment block (chat has no system role here).
 *
 * Capability-gated: `supportsFim` is conservative (DeepSeek kind + known FIM
 * model ids, or explicit `config.fim`). The caller degrades to chat on an
 * endpoint/param mismatch (400/404), so a wrong guess never breaks completion.
 * Shares the base-URL/auth resolution with the chat helper. Never throws.
 */
import type { ResolvedBinding } from '../pipelines/index.js';
import {
  resolveBaseUrl,
  parseRetryAfter,
  type ChatCallOptions,
  type ChatCallResult,
} from './llm-chat.js';
import { resolveFimTemplate, mergeStops, commentize, lineCommentPrefix } from './fim-templates.js';
import { fimFlavor, renderFimContext, type FimSnippet } from './fim-format.js';

/** Model ids with a native FIM completions endpoint (prompt + suffix). */
const FIM_MODEL_RE = /(deepseek-coder|qwen[\d.]*-?coder|codestral|starcoder|stable-?code|codegemma|\bfim\b)/i;
/** Reasoning models are chat-only — no `/beta/completions` (FIM) endpoint. */
const REASONING_MODEL_RE = /(reasoner|\br1\b|-r1|think)/i;

// A binding whose FIM endpoint answered 400/404 is parked here so we stop
// re-probing it on every keystroke (the caller marks it on failure). 1h TTL —
// long enough to avoid a per-keystroke double-call, short enough to recover
// after a config fix. Module-level → shared across both handler instances.
// Bounded by provider×model cardinality (a handful per install), so no eviction
// sweep is needed; entries are TTL-checked lazily on read.
const FIM_DEAD_TTL_MS = 60 * 60_000;
const fimDead = new Map<string, number>();

function fimKey(binding: ResolvedBinding): string {
  return `${binding.provider.id}:${binding.modelId}`;
}

/** True when this binding should use the native FIM endpoint over chat. */
export function supportsFim(binding: ResolvedBinding): boolean {
  const cfg = binding.config as Record<string, unknown>;
  if (cfg.fim === false) return false; // explicit opt-out
  // Explicit opt-in wins over BOTH auto-detection and the parked-dead memo —
  // the admin forced FIM, so honor it even after failures (they can flip it off).
  if (cfg.fim === true) return true;
  const deadUntil = fimDead.get(fimKey(binding));
  if (deadUntil !== undefined && deadUntil > Date.now()) return false; // known dead endpoint
  if (REASONING_MODEL_RE.test(binding.modelId)) return false; // chat-only models
  if (binding.provider.kind === 'deepseek') return true; // /beta/completions, stable
  // Mistral has a native /fim/completions endpoint, but only the code models
  // are trained for it — mistral-small et al. are chat-only.
  if (binding.provider.kind === 'mistral') return /codestral|devstral/i.test(binding.modelId);
  return FIM_MODEL_RE.test(binding.modelId);
}

/**
 * Mark a binding's FIM endpoint as unavailable (a 400/404 came back) so
 * `supportsFim` stops choosing it — turns a persistent per-keystroke
 * FIM→chat double-call into a single chat call after the first probe.
 */
export function markFimUnsupported(binding: ResolvedBinding): void {
  fimDead.set(fimKey(binding), Date.now() + FIM_DEAD_TTL_MS);
}

export interface FimInput {
  prefix: string;
  suffix: string;
  /** Legacy single-block context (rendered as a leading comment block). */
  context: string;
  /** Monaco language id — picks the comment syntax for the context block. */
  language: string;
  /**
   * Engine-v2 cross-file snippets (recent edits / defs / open-tab windows) —
   * rendered in the model family's native multi-file format (fim-format.ts).
   * When present, `context` is ignored.
   */
  snippets?: FimSnippet[];
  /** Scope + receiver members — commented block right before the prefix. */
  volatileBlock?: string;
  /** Project-relative path of the file being completed (multi-file headers). */
  filePath?: string;
  /** Repo display name for qwen's <|repo_name|> header. */
  repoName?: string;
}

interface FimResponse {
  // OpenAI-compatible completion hosts use `text`; current Mistral FIM uses
  // the chat-completion choice shape (`message.content`). Accept both.
  choices?: Array<{ text?: string; message?: { content?: string } }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

/** Resolve the FIM completions endpoint (config override → kind-specific → legacy). */
function fimUrl(binding: ResolvedBinding): string {
  const cfg = binding.config as Record<string, unknown>;
  if (typeof cfg.fim_endpoint === 'string' && cfg.fim_endpoint.trim()) return cfg.fim_endpoint.trim();
  const base = resolveBaseUrl(binding).replace(/\/+$/, '');
  // DeepSeek serves FIM under /beta, not /v1.
  if (binding.provider.kind === 'deepseek') return `${base.replace(/\/v1$/, '')}/beta/completions`;
  // Mistral's current native FIM endpoint lives on the public API host.
  if (binding.provider.kind === 'mistral') return `${base}/fim/completions`;
  return `${base}/completions`;
}

function toNumber(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

/**
 * One native FIM completion call. Same fail-open contract as
 * openAiCompatibleChat — returns `{ content: '', errorBody, status }` on any
 * failure so the caller can classify (and fall back to chat on 400/404).
 */
export async function fimCompletion(
  binding: ResolvedBinding,
  input: FimInput,
  options: ChatCallOptions = {},
): Promise<ChatCallResult> {
  const startedAt = performance.now();
  const cfg = binding.config as Record<string, unknown>;
  // Context: v2 snippet path (family-native multi-file format) or the legacy
  // single commented block.
  let contextText: string;
  let flavorStop: string[] = [];
  if (input.snippets !== undefined || input.volatileBlock !== undefined) {
    const rendered = renderFimContext(fimFlavor(binding.modelId), input.snippets ?? [], {
      repoName: input.repoName ?? 'repo',
      currentFile: input.filePath ?? '',
      commentPrefix: lineCommentPrefix(input.language),
      volatileBlock: input.volatileBlock,
    });
    contextText = rendered.contextText;
    flavorStop = rendered.extraStop;
  } else {
    contextText = input.context ? `${commentize(input.context, input.language)}\n\n` : '';
  }
  const prompt = contextText ? `${contextText}${input.prefix}` : input.prefix;
  const body: Record<string, unknown> = {
    model: binding.modelId,
    max_tokens: options.maxTokens ?? toNumber(cfg.max_tokens) ?? 256,
    temperature: options.temperature ?? toNumber(cfg.temperature) ?? 0.2,
  };
  // Raw-template hosts don't understand the `suffix` param — the template
  // folds prefix+suffix into a single sentinel-token prompt instead.
  // Stop merge order (cap 4): caller '\n' → template stops → flavor stops.
  const tpl = resolveFimTemplate(binding);
  if (tpl) {
    body.prompt = tpl.assemble({ prefix: prompt, suffix: input.suffix });
    const stops = mergeStops(options.stop, [...tpl.stop, ...flavorStop]);
    if (stops.length > 0) body.stop = stops;
  } else {
    body.prompt = prompt;
    body.suffix = input.suffix;
    const stops = mergeStops(options.stop, flavorStop);
    if (stops.length > 0) body.stop = stops;
  }

  const timeoutMs = options.timeoutMs ?? Math.max(1000, toNumber(cfg.timeout) ?? 30_000);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  if (options.signal) {
    if (options.signal.aborted) controller.abort();
    else options.signal.addEventListener('abort', () => controller.abort(), { once: true });
  }
  const fetchImpl = options.fetchFn ?? fetch;
  try {
    const res = await fetchImpl(fimUrl(binding), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(binding.provider.api_key ? { authorization: `Bearer ${binding.provider.api_key}` } : {}),
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const latencyMs = performance.now() - startedAt;
    if (!res.ok) {
      const errorBody = await res.text().catch(() => '');
      return {
        content: '',
        errorBody: errorBody.slice(0, 2000),
        status: res.status,
        retryAfterMs: parseRetryAfter(res.headers.get('retry-after')),
        latencyMs,
        finishReason: 'error',
      };
    }
    const parsed = (await res.json()) as FimResponse;
    return {
      content: parsed.choices?.[0]?.text ?? parsed.choices?.[0]?.message?.content ?? '',
      tokensIn: parsed.usage?.prompt_tokens,
      tokensOut: parsed.usage?.completion_tokens,
      latencyMs,
      ttftMs: latencyMs,
      finishReason: 'provider',
    };
  } catch (e) {
    return {
      content: '', errorBody: (e as Error).message, latencyMs: performance.now() - startedAt,
      finishReason: controller.signal.aborted ? (options.signal?.aborted ? 'aborted' : 'timeout') : 'error',
    };
  } finally {
    clearTimeout(timer);
  }
}
