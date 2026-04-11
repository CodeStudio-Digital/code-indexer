import { OpenAIProvider } from './openai.js';
import type { LLMProvider } from './base.js';
import type { AnalysisResult } from '../../../types.js';

export class DeepSeekProvider implements LLMProvider {
  readonly name = 'deepseek';
  readonly model: string;
  private inner: OpenAIProvider;

  constructor(apiKey?: string, model?: string) {
    this.model = model ?? 'deepseek-chat';
    this.inner = new OpenAIProvider(
      apiKey ?? process.env.DEEPSEEK_API_KEY,
      this.model,
      'https://api.deepseek.com'
    );
  }

  analyzeFile(filePath: string, content: string): Promise<AnalysisResult> {
    return this.inner.analyzeFile(filePath, content);
  }

  analyzeSummary(
    filePath: string,
    content: string,
    symbols: Array<{ name: string; kind: string; signature: string; line?: number | null; end_line?: number }>
  ): Promise<AnalysisResult> {
    return this.inner.analyzeSummary(filePath, content, symbols);
  }
}
