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
  /** Layered project context (rendered as a leading comment block). */
  context: string;
  /** Monaco language id — picks the comment syntax for the context block. */
  language: string;
}

interface FimResponse {
  choices?: Array<{ text?: string }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

function lineCommentPrefix(language: string): string {
  if (/^(python|ruby|shell|bash|sh|yaml|r|perl|toml|dockerfile|makefile|elixir)$/i.test(language)) return '# ';
  if (/^(sql|lua|haskell|ada)$/i.test(language)) return '-- ';
  return '// ';
}

function commentize(block: string, language: string): string {
  const c = lineCommentPrefix(language);
  return block.split('\n').map((l) => (l ? c + l : c.trimEnd())).join('\n');
}

/** Resolve the FIM completions endpoint (config override → DeepSeek beta → legacy). */
function fimUrl(binding: ResolvedBinding): string {
  const cfg = binding.config as Record<string, unknown>;
  if (typeof cfg.fim_endpoint === 'string' && cfg.fim_endpoint.trim()) return cfg.fim_endpoint.trim();
  const base = resolveBaseUrl(binding).replace(/\/+$/, '');
  // DeepSeek serves FIM under /beta, not /v1.
  if (binding.provider.kind === 'deepseek') return `${base.replace(/\/v1$/, '')}/beta/completions`;
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
  const prompt = input.context
    ? `${commentize(input.context, input.language)}\n\n${input.prefix}`
    : input.prefix;
  const body: Record<string, unknown> = {
    model: binding.modelId,
    prompt,
    suffix: input.suffix,
    max_tokens: options.maxTokens ?? toNumber(cfg.max_tokens) ?? 256,
    temperature: options.temperature ?? toNumber(cfg.temperature) ?? 0.2,
  };
  if (options.stop && options.stop.length > 0) body.stop = options.stop.slice(0, 4);

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
      };
    }
    const parsed = (await res.json()) as FimResponse;
    return {
      content: parsed.choices?.[0]?.text ?? '',
      tokensIn: parsed.usage?.prompt_tokens,
      tokensOut: parsed.usage?.completion_tokens,
      latencyMs,
    };
  } catch (e) {
    return { content: '', errorBody: (e as Error).message, latencyMs: performance.now() - startedAt };
  } finally {
    clearTimeout(timer);
  }
}
