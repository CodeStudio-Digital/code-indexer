import Anthropic from '@anthropic-ai/sdk';
import type { LLMProvider } from './base.js';
import { SYSTEM_PROMPT, buildUserPrompt, parseAnalysisResponse } from './base.js';
import type { AnalysisResult } from '../../../types.js';

export class AnthropicProvider implements LLMProvider {
  readonly name = 'anthropic';
  readonly model: string;
  private client: Anthropic;

  constructor(apiKey?: string, model?: string, baseURL?: string) {
    this.model = model ?? 'claude-haiku-4-5-20251001';
    this.client = new Anthropic({
      apiKey: apiKey ?? process.env.ANTHROPIC_API_KEY,
      ...(baseURL ? { baseURL } : {}),
    });
  }

  async analyzeFile(filePath: string, content: string): Promise<AnalysisResult> {
    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: 4096,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: buildUserPrompt(filePath, content) }],
    });

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
