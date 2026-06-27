import OpenAI from 'openai';
import type { LLMProvider } from '@mcp/indexer/indexer/providers/base.js';
import {
  SYSTEM_PROMPT,
  SUMMARY_ONLY_SYSTEM_PROMPT,
  buildSummaryUserPrompt,
  buildUserPrompt,
  parseAnalysisResponse,
} from '@mcp/indexer/indexer/providers/base.js';
import type { AnalysisResult } from '@mcp/shared/types.js';
import { nativeFetch } from '@mcp/shared/utils/native-fetch.js';
import { shouldOmitKimiTemperature } from '@mcp/code-agent/providers/kimi-code.js';

export class KimiCodeProvider implements LLMProvider {
  readonly name = 'kimi-code';
  readonly model: string;
  private client: OpenAI;

  constructor(
    apiKey?: string,
    model?: string,
    baseURL?: string,
    defaultHeaders?: Record<string, string>,
  ) {
    this.model = model ?? 'kimi-k2.6';
    this.client = new OpenAI({
      apiKey,
      baseURL: baseURL ?? 'https://api.kimi.com/coding/v1',
      ...(defaultHeaders ? { defaultHeaders } : {}),
      // Use undici (native fetch) instead of bundled node-fetch@2.
      fetch: nativeFetch(),
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
      ...(shouldOmitKimiTemperature(this.model) ? {} : { temperature: 0 }),
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
    symbols: Array<{ name: string; kind: string; signature: string; line?: number | null; end_line?: number }>,
  ): Promise<AnalysisResult> {
    const response = await this.client.chat.completions.create({
      model: this.model,
      messages: [
        { role: 'system', content: SUMMARY_ONLY_SYSTEM_PROMPT },
        { role: 'user', content: buildSummaryUserPrompt(filePath, content, symbols) },
      ],
      max_tokens: 1024,
      ...(shouldOmitKimiTemperature(this.model) ? {} : { temperature: 0 }),
    });

    const text = response.choices[0]?.message?.content ?? '{}';
    return {
      analysis: parseAnalysisResponse(text, filePath),
      inputTokens: response.usage?.prompt_tokens ?? 0,
      outputTokens: response.usage?.completion_tokens ?? 0,
    };
  }
}
