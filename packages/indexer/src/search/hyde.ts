/**
 * HyDE — Hypothetical Document Embeddings.
 *
 * HyDE is an optional query-expansion stage for semantic code search. Its
 * provider and model are owned exclusively by the
 * `indexer_search / hyde` PipelineBinding. An absent binding means disabled;
 * callers then keep the original query and continue with normal FTS/vector
 * retrieval.
 *
 * Keeping this behind PipelineProviderResolver avoids the old split-brain
 * configuration where every provider row exposed its own model override,
 * even though only the default provider was ever consulted at runtime.
 */
import type {
  PipelineProviderResolver,
  ResolvedBinding,
} from '@mcp/services/pipelines/index.js';
import {
  callConfiguredChat,
  callChatWithFailover,
  type ChatFn,
  type ChatMessage,
} from '@mcp/services/quality/index.js';

type HyDEBindingResolver = Pick<PipelineProviderResolver, 'resolveChain'>;

export interface HyDEServiceOptions {
  /** Test seam; production uses the shared pipeline chat dispatcher. */
  chat?: ChatFn;
}

export class HyDEService {
  private readonly cache = new Map<string, string>();
  private readonly cacheMax = 128;

  constructor(
    private readonly resolver: HyDEBindingResolver | null,
    private readonly options: HyDEServiceOptions = {},
  ) {}

  /**
   * Generate a short hypothetical code document for `query`.
   *
   * Fail-open contract: disabled/missing bindings, provider errors and empty
   * replies all return the original query. Hybrid search therefore never
   * depends on an LLM being reachable.
   */
  async generate(
    query: string,
    projectContext?: { language?: string; concepts?: string[] },
  ): Promise<string> {
    const key = query.trim();
    if (!key || !this.resolver) return query;

    // No implicit default provider/model. The pipeline binding is the single
    // source of truth and its absence is the explicit "HyDE disabled" state.
    const chain = await this.resolver.resolveChain('indexer_search', 'hyde', {});
    if (chain.length === 0) return query;

    // Include the resolved chain in the cache key so changing provider/model
    // or config takes effect immediately without restarting the application.
    const cacheKey = this.cacheKey(key, chain, projectContext);
    const cached = this.cache.get(cacheKey);
    if (cached) return cached;

    const messages: ChatMessage[] = [
      { role: 'user', content: buildHyDEPrompt(key, projectContext) },
    ];
    const { result } = await callChatWithFailover(
      chain,
      (binding) => {
        const chat = this.options.chat ?? callConfiguredChat;
        return chat(binding, messages, {
          temperature: finiteNumber(binding.config.temperature) ?? 0.2,
          maxTokens: finiteNumber(binding.config.max_tokens) ?? 180,
          timeoutMs:
            finiteNumber(binding.config.timeout_ms)
            ?? finiteNumber(binding.config.timeout)
            ?? 20_000,
        });
      },
      { label: 'HyDE query expansion', codePrefix: 'hyde' },
    );

    if (result.errorBody) {
      console.warn(`[hyde] generation unavailable: ${result.errorBody}`);
      return query;
    }

    const cleaned = this.clean(result.content);
    if (!cleaned || cleaned.length < 8) return query;
    if (!isCompatibleWithProject(cleaned, projectContext?.language)) {
      console.warn(
        `[hyde] rejected generated document incompatible with ${
          projectContext?.language ?? 'project language'
        }`,
      );
      return query;
    }
    if (this.cache.size >= this.cacheMax) {
      const first = this.cache.keys().next().value;
      if (first !== undefined) this.cache.delete(first);
    }
    this.cache.set(cacheKey, cleaned);
    return cleaned;
  }

  private cacheKey(
    query: string,
    chain: ResolvedBinding[],
    projectContext?: { language?: string; concepts?: string[] },
  ): string {
    return JSON.stringify({
      query,
      projectContext: {
        language: projectContext?.language ?? null,
        concepts: projectContext?.concepts?.slice(0, 8) ?? [],
      },
      bindings: chain.map((binding) => ({
        id: binding.bindingId,
        provider: binding.provider.id,
        model: binding.modelId,
        mode: binding.modelMode,
        config: binding.config,
      })),
    });
  }

  /** Strip fences / boilerplate and cap the synthetic document size. */
  private clean(text: string): string {
    let value = text.trim();
    const fenced = value.match(/```(?:[a-zA-Z]+)?\n?([\s\S]*?)```/);
    if (fenced) value = fenced[1].trim();
    value = value.replace(/\n{3,}/g, '\n\n').trim();
    if (value.length <= 500) return value;
    const completeLine = value.lastIndexOf('\n', 500);
    // A single overlong line cannot be truncated safely without changing the
    // synthetic identifier/type content. Fall back to the raw query instead.
    return completeLine >= 80 ? value.slice(0, completeLine).trim() : '';
  }
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function isCompatibleWithProject(text: string, language?: string): boolean {
  const normalized = language?.trim().toLowerCase();
  if (!normalized) return true;
  const python = /(?:^|\n)\s*(?:async\s+)?def\s+\w+\s*\(|(?:^|\n)\s*(?:from\s+\S+\s+)?import\s+\S+|\bself\./m.test(text);
  const php = /<\?php|\$\w+|->|::|\bfunction\s+\w+\s*\(/m.test(text);
  const jsLike = /\b(?:const|let|interface|type|export|import)\b|=>|:\s*(?:string|number|boolean)\b/.test(text);

  if (normalized === 'php') return !python || php;
  if (normalized === 'python' || normalized === 'py') return !php || python;
  if (
    normalized.includes('typescript')
    || normalized === 'ts'
    || normalized.includes('javascript')
    || normalized === 'js'
  ) {
    return !python || jsLike;
  }
  return true;
}

/**
 * Prime the model toward code-shaped output rather than an explanatory essay,
 * which places the generated text nearer to indexed source-code embeddings.
 */
function buildHyDEPrompt(
  query: string,
  ctx?: { language?: string; concepts?: string[] },
): string {
  const contextHint = ctx
    ? `\nProject context: ${ctx.language ? `primary language: ${ctx.language}` : ''}${ctx.concepts?.length ? `, key concepts: ${ctx.concepts.slice(0, 8).join(', ')}` : ''}\n`
    : '';

  return `Write a short hypothetical code snippet or docstring (3-6 lines) that would answer this question. Do not explain. Output only code-like content with key function/class names and types. No markdown fences.
${contextHint}
Question: ${query}

Hypothetical snippet:`;
}
