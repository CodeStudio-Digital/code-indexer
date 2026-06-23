import OpenAI from 'openai';
import type { LLMProvider } from '@mcp/indexer/indexer/providers/base.js';
import { SYSTEM_PROMPT, SUMMARY_ONLY_SYSTEM_PROMPT, buildUserPrompt, buildSummaryUserPrompt, parseAnalysisResponse } from '@mcp/indexer/indexer/providers/base.js';
import type { AnalysisResult } from '@mcp/shared/types.js';

export class OpenAIProvider implements LLMProvider {
  readonly name = 'openai';
  readonly model: string;
  /**
   * Cheap model used for summary-only analysis. When undefined, `analyzeSummary`
   * falls through to `model`. Callers wrapping this class for non-OpenAI APIs
   * (DeepSeek, ZAI, Cloudflare AI Gateway, ...) should leave `summaryModel`
   * unset OR pass the cheap variant of their own family — never gpt-4o-mini
   * which would fail against a different endpoint.
   *
   * The OpenAI provider definition (`src/core/providers/definitions/openai.ts`)
   * passes `gpt-4o-mini` explicitly so users who pick gpt-4o for `model` still
   * get cheap summaries by default.
   */
  readonly summaryModel?: string;
  private client: OpenAI;

  constructor(
    apiKey?: string,
    model?: string,
    baseURL?: string,
    defaultHeaders?: Record<string, string>,
    summaryModel?: string,
  ) {
    this.model = model ?? 'gpt-4o-mini';
    this.summaryModel = summaryModel;
    this.client = new OpenAI({
      apiKey: apiKey ?? process.env.OPENAI_API_KEY,
      ...(baseURL ? { baseURL } : {}),
      ...(defaultHeaders ? { defaultHeaders } : {}),
    });
  }

  async analyzeFile(filePath: string, content: string): Promise<AnalysisResult> {
    const response = await this.client.chat.completions.create({
      model: this.model,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: buildUserPrompt(filePath, content) },
      ],
      max_tokens: 4096,
      temperature: 0,
    });

    const text = response.choices[0]?.message?.content ?? '{}';

    return {
      analysis: parseAnalysisResponse(text, filePath),
      inputTokens: response.usage?.prompt_tokens ?? 0,
      outputTokens: response.usage?.completion_tokens ?? 0,
    };
  }

  async analyzeSummary(
    filePath: string,
    content: string,
    symbols: Array<{ name: string; kind: string; signature: string; line?: number | null; end_line?: number }>
  ): Promise<AnalysisResult> {
    const response = await this.client.chat.completions.create({
      model: this.summaryModel ?? this.model,
      messages: [
        { role: 'system', content: SUMMARY_ONLY_SYSTEM_PROMPT },
        { role: 'user', content: buildSummaryUserPrompt(filePath, content, symbols) },
      ],
      max_tokens: 1024,
      temperature: 0,
    });

    const text = response.choices[0]?.message?.content ?? '{}';

    return {
      analysis: parseAnalysisResponse(text, filePath),
      inputTokens: response.usage?.prompt_tokens ?? 0,
      outputTokens: response.usage?.completion_tokens ?? 0,
    };
  }
}
