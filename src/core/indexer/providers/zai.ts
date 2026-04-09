import { OpenAIProvider } from './openai.js';
import type { LLMProvider } from './base.js';
import type { AnalysisResult } from '../../../types.js';

// Coding models use a dedicated endpoint
const ZAI_CODING_MODELS = new Set([
  'glm-5.1',
  'glm-5-turbo',
  'glm-4-plus',
  'codegeex-4',
  'codegeex-4-flash',
]);

const ZAI_GENERAL_URL = 'https://api.z.ai/api/paas/v4/';
const ZAI_CODING_URL = 'https://api.z.ai/api/coding/paas/v4/';

function resolveBaseURL(model: string, baseURL?: string): string {
  if (baseURL) return baseURL;
  if (process.env.ZAI_BASE_URL) return process.env.ZAI_BASE_URL;
  return ZAI_CODING_MODELS.has(model) ? ZAI_CODING_URL : ZAI_GENERAL_URL;
}

export class ZAIProvider implements LLMProvider {
  readonly name = 'zai';
  readonly model: string;
  private inner: OpenAIProvider;

  constructor(apiKey?: string, model?: string, baseURL?: string) {
    this.model = model ?? 'glm-5.1';
    this.inner = new OpenAIProvider(
      apiKey ?? process.env.ZAI_API_KEY,
      this.model,
      resolveBaseURL(this.model, baseURL)
    );
  }

  analyzeFile(filePath: string, content: string): Promise<AnalysisResult> {
    return this.inner.analyzeFile(filePath, content);
  }
}
