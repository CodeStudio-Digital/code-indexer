import OpenAI from 'openai';
import type { LLMProvider } from './base.js';
import { SYSTEM_PROMPT, buildUserPrompt, parseAnalysisResponse } from './base.js';
import type { AnalysisResult } from '../../../types.js';

export class OpenAIProvider implements LLMProvider {
  readonly name = 'openai';
  readonly model: string;
  private client: OpenAI;

  constructor(
    apiKey?: string,
    model?: string,
    baseURL?: string,
    defaultHeaders?: Record<string, string>
  ) {
    this.model = model ?? 'gpt-4o-mini';
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
}
