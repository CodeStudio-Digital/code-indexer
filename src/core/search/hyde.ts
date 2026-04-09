/**
 * HyDE — Hypothetical Document Embeddings.
 *
 * Given a natural-language query, ask an LLM to draft a short, hypothetical
 * *answer snippet* (docstring-style) that would plausibly live in the
 * codebase. Embed that synthetic document and use the resulting vector for
 * ANN search. On code corpora with NL questions, this recovers tokens the
 * raw query would never match ("how does the retry loop handle 429s?" →
 * hypothetical: `// Exponential backoff retry handler for HTTP 429 responses`).
 *
 * We deliberately do NOT touch the LLMProvider interface: HyDE only needs a
 * one-shot chat completion, and adding a generic `complete()` to every
 * provider would ripple across 6 files. Instead this service spins up its
 * own minimal client from the ProviderStore default row.
 *
 * Supports two shapes:
 *   - Anthropic (claude-haiku-4-5) via @anthropic-ai/sdk
 *   - OpenAI-compatible (openai, zai, deepseek, ...) via openai SDK
 *
 * Results are cached in-process keyed by query — consecutive calls for the
 * same question are free.
 */
import type { ProviderStore, ProviderConfig } from '../../store/provider-store.js';

export class HyDEService {
  private store: ProviderStore | null;
  private cache = new Map<string, string>();
  private cacheMax = 128;

  constructor(store: ProviderStore | null) {
    this.store = store;
  }

  /**
   * Return the cached hypothetical document for this query if present,
   * otherwise generate one, cache, and return. On any error the query is
   * returned unchanged — the caller should treat "HyDE output === input"
   * as a graceful fallback.
   */
  async generate(query: string): Promise<string> {
    const key = query.trim();
    if (!key) return query;

    const cached = this.cache.get(key);
    if (cached) return cached;

    if (!this.store) return query;
    const cfg = this.pickProvider();
    if (!cfg) return query;

    try {
      const text = await this.callLLM(cfg, key);
      const cleaned = this.clean(text);
      if (!cleaned || cleaned.length < 8) return query;
      // LRU-ish eviction: drop oldest when full.
      if (this.cache.size >= this.cacheMax) {
        const first = this.cache.keys().next().value;
        if (first !== undefined) this.cache.delete(first);
      }
      this.cache.set(key, cleaned);
      return cleaned;
    } catch (err) {
      console.error('[hyde] generation failed:', (err as Error).message);
      return query;
    }
  }

  /**
   * Pick the default-enabled provider suitable for one-shot chat. We avoid
   * the OAuth kinds (copilot/chatgpt) because they need async token refresh
   * that isn't worth threading through for a ~50-token call — the fallback
   * to raw query is acceptable when the default is copilot.
   */
  private pickProvider(): ProviderConfig | null {
    if (!this.store) return null;
    const rows = this.store.listProviders({ enabled: true });
    const usable = rows.filter(
      (r) => r.api_key && r.kind !== 'copilot' && r.kind !== 'chatgpt' && r.kind !== 'bedrock'
    );
    if (usable.length === 0) return null;
    return usable.find((r) => r.is_default) ?? usable[0];
  }

  private async callLLM(cfg: ProviderConfig, query: string): Promise<string> {
    const prompt = buildHyDEPrompt(query);
    if (cfg.kind === 'anthropic') return this.callAnthropic(cfg, prompt);
    // OpenAI-compatible: openai, zai, deepseek, and any "kind: openai" custom.
    return this.callOpenAICompat(cfg, prompt);
  }

  private async callAnthropic(cfg: ProviderConfig, prompt: string): Promise<string> {
    const { default: Anthropic } = (await import('@anthropic-ai/sdk')) as {
      default: new (opts: { apiKey: string; baseURL?: string }) => {
        messages: {
          create(req: {
            model: string;
            max_tokens: number;
            messages: Array<{ role: string; content: string }>;
          }): Promise<{ content: Array<{ type: string; text?: string }> }>;
        };
      };
    };
    const client = new Anthropic({
      apiKey: cfg.api_key ?? '',
      ...(cfg.base_url ? { baseURL: cfg.base_url } : {}),
    });
    const resp = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 180,
      messages: [{ role: 'user', content: prompt }],
    });
    return resp.content
      .filter((b) => b.type === 'text')
      .map((b) => b.text ?? '')
      .join('');
  }

  private async callOpenAICompat(cfg: ProviderConfig, prompt: string): Promise<string> {
    const { default: OpenAI } = (await import('openai')) as {
      default: new (opts: { apiKey: string; baseURL?: string }) => {
        chat: {
          completions: {
            create(req: {
              model: string;
              max_tokens: number;
              temperature: number;
              messages: Array<{ role: string; content: string }>;
            }): Promise<{ choices: Array<{ message?: { content?: string } }> }>;
          };
        };
      };
    };
    // Pick a cheap default model per shape. Overridden only if the user set
    // `extra.hyde_model` on the provider row.
    const extraModel = (cfg.extra as { hyde_model?: string } | undefined)?.hyde_model;
    const model = extraModel ?? this.defaultModelFor(cfg.kind);

    const client = new OpenAI({
      apiKey: cfg.api_key ?? '',
      ...(cfg.base_url ? { baseURL: cfg.base_url } : {}),
    });
    const resp = await client.chat.completions.create({
      model,
      max_tokens: 180,
      temperature: 0.2,
      messages: [{ role: 'user', content: prompt }],
    });
    return resp.choices[0]?.message?.content ?? '';
  }

  private defaultModelFor(kind: string): string {
    switch (kind) {
      case 'openai':
        return 'gpt-4o-mini';
      case 'deepseek':
        return 'deepseek-chat';
      case 'zai':
        return 'glm-4.5-flash';
      case 'gemini':
        return 'gemini-2.0-flash-lite';
      default:
        return 'gpt-4o-mini';
    }
  }

  /**
   * Strip fences / boilerplate and cap length. The LLM occasionally
   * over-answers with explanatory prose; we only want the hypothetical
   * snippet that gets embedded.
   */
  private clean(text: string): string {
    let t = text.trim();
    // Remove triple-fenced blocks but keep their contents.
    const fenced = t.match(/```(?:[a-zA-Z]+)?\n?([\s\S]*?)```/);
    if (fenced) t = fenced[1].trim();
    // Collapse excessive whitespace.
    t = t.replace(/\n{3,}/g, '\n\n').trim();
    // Cap to ~500 chars — embeddings are insensitive to length beyond that.
    return t.slice(0, 500);
  }
}

/**
 * Build the one-shot prompt. Short, concrete, and primed toward
 * code-shaped output (comments + signatures) rather than natural language
 * essays — the goal is to land in the same embedding neighborhood as the
 * actual source code.
 */
function buildHyDEPrompt(query: string): string {
  return `Write a short hypothetical code snippet or docstring (3-6 lines) that would answer this question. Do not explain. Output only code-like content with key function/class names and types. No markdown fences.

Question: ${query}

Hypothetical snippet:`;
}
