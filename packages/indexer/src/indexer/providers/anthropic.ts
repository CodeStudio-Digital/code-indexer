import Anthropic, { type ClientOptions } from '@anthropic-ai/sdk';
import { nativeFetch } from '@mcp/shared/utils/native-fetch.js';
import type { LLMProvider } from '@mcp/indexer/indexer/providers/base.js';
import { SYSTEM_PROMPT, SUMMARY_ONLY_SYSTEM_PROMPT, buildUserPrompt, buildSummaryUserPrompt, parseAnalysisResponse } from '@mcp/indexer/indexer/providers/base.js';
import type { AnalysisResult } from '@mcp/shared/types.js';

type AnthropicTextResponse = {
  content: Array<{ type: string; text?: string }>;
  usage: {
    input_tokens: number;
    output_tokens: number;
  };
};

export class AnthropicProvider implements LLMProvider {
  readonly name: string;
  readonly model: string;
  /**
   * Cheap model used for summary-only analysis. Defaults to claude-haiku-4-5.
   * Lets callers pick an expensive `model` (e.g. claude-opus-4-7) for full
   * structural analysis while keeping summaries on haiku. Override via
   * `opts.summaryModel`. Anthropic's API is single-vendor, so a default is
   * always safe — unlike OpenAI-compat wrappers that proxy to other vendors.
   */
  readonly summaryModel: string;
  private client: Anthropic;
  private defaultMetadata?: Anthropic.Metadata;
  private defaultBetas?: string[];
  private defaultTemperature?: number;
  private defaultSystemPrefixBlocks?: Anthropic.TextBlockParam[];
  private useBetaMessages: boolean;

  constructor(
    apiKey?: string,
    model?: string,
    baseURL?: string,
    opts?: {
      authToken?: string;
      defaultHeaders?: Record<string, string>;
      defaultMetadata?: Anthropic.Metadata;
      defaultBetas?: string[];
      defaultTemperature?: number;
      systemPrefixBlocks?: Anthropic.TextBlockParam[];
      maxRetries?: number;
      dangerouslyAllowBrowser?: boolean;
      fetch?: typeof fetch;
      useBetaMessages?: boolean;
      name?: string;
      summaryModel?: string;
    },
  ) {
    this.name = opts?.name ?? 'anthropic';
    this.model = model ?? 'claude-haiku-4-5-20251001';
    this.summaryModel = opts?.summaryModel ?? 'claude-haiku-4-5-20251001';
    this.defaultMetadata = opts?.defaultMetadata;
    this.defaultBetas = opts?.defaultBetas;
    this.defaultTemperature = opts?.defaultTemperature;
    this.defaultSystemPrefixBlocks = opts?.systemPrefixBlocks;
    this.useBetaMessages = opts?.useBetaMessages ?? false;
    this.client = new Anthropic({
      apiKey: opts?.authToken ? null : (apiKey ?? ''),
      ...(opts?.maxRetries !== undefined ? { maxRetries: opts.maxRetries } : {}),
      ...(opts?.authToken ? { authToken: opts.authToken } : {}),
      ...(baseURL ? { baseURL } : {}),
      ...(opts?.defaultHeaders ? { defaultHeaders: opts.defaultHeaders } : {}),
      ...(opts?.dangerouslyAllowBrowser !== undefined
        ? { dangerouslyAllowBrowser: opts.dangerouslyAllowBrowser }
        : {}),
      // Default to undici (native fetch) so the SDK avoids bundled node-fetch@2
      // and installLlmDispatcher's bodyTimeout:0 applies. Explicit opts.fetch wins.
      fetch: (opts?.fetch ?? nativeFetch()) as unknown as ClientOptions['fetch'],
    });
  }

  private buildSystem(text: string): string | Anthropic.TextBlockParam[] {
    if (!this.defaultSystemPrefixBlocks?.length) return text;
    return [...this.defaultSystemPrefixBlocks, { type: 'text', text }];
  }

  async analyzeFile(filePath: string, content: string): Promise<AnalysisResult> {
    const params = {
      model: this.model,
      max_tokens: 4096,
      system: this.buildSystem(SYSTEM_PROMPT),
      messages: [{ role: 'user', content: buildUserPrompt(filePath, content) }],
      metadata: this.defaultMetadata,
      ...(typeof this.defaultTemperature === 'number'
        ? { temperature: this.defaultTemperature }
        : {}),
      ...(this.useBetaMessages && this.defaultBetas?.length
        ? { betas: this.defaultBetas }
        : {}),
    };
    const response = (this.useBetaMessages
      ? await this.client.beta.messages.create(
        params as Parameters<typeof this.client.beta.messages.create>[0],
      )
      : await this.client.messages.create(params as Anthropic.MessageCreateParamsNonStreaming)) as AnthropicTextResponse;

    const text = response.content
      .filter(block => block.type === 'text')
      .map(block => block.text)
      .join('');

    return {
      analysis: parseAnalysisResponse(text, filePath),
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
    };
  }

  async analyzeSummary(
    filePath: string,
    content: string,
    symbols: Array<{ name: string; kind: string; signature: string; line?: number | null; end_line?: number }>
  ): Promise<AnalysisResult> {
    const params = {
      model: this.summaryModel,
      max_tokens: 1024,
      system: this.buildSystem(SUMMARY_ONLY_SYSTEM_PROMPT),
      messages: [{ role: 'user', content: buildSummaryUserPrompt(filePath, content, symbols) }],
      metadata: this.defaultMetadata,
      ...(typeof this.defaultTemperature === 'number'
        ? { temperature: this.defaultTemperature }
        : {}),
      ...(this.useBetaMessages && this.defaultBetas?.length
        ? { betas: this.defaultBetas }
        : {}),
    };
    const response = (this.useBetaMessages
      ? await this.client.beta.messages.create(
        params as Parameters<typeof this.client.beta.messages.create>[0],
      )
      : await this.client.messages.create(params as Anthropic.MessageCreateParamsNonStreaming)) as AnthropicTextResponse;

    const text = response.content
      .filter(block => block.type === 'text')
      .map(block => block.text)
      .join('');

    return {
      analysis: parseAnalysisResponse(text, filePath),
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
    };
  }
}
