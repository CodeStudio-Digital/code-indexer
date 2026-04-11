import { GoogleGenerativeAI } from '@google/generative-ai';
import type { LLMProvider } from './base.js';
import { SYSTEM_PROMPT, SUMMARY_ONLY_SYSTEM_PROMPT, buildUserPrompt, buildSummaryUserPrompt, parseAnalysisResponse } from './base.js';
import type { AnalysisResult } from '../../../types.js';

export class GeminiProvider implements LLMProvider {
  readonly name = 'gemini';
  readonly model: string;
  private genAI: GoogleGenerativeAI;

  constructor(apiKey?: string, model?: string) {
    this.model = model ?? 'gemini-2.0-flash';
    this.genAI = new GoogleGenerativeAI(apiKey ?? process.env.GEMINI_API_KEY ?? '');
  }

  async analyzeFile(filePath: string, content: string): Promise<AnalysisResult> {
    const model = this.genAI.getGenerativeModel({
      model: this.model,
      systemInstruction: SYSTEM_PROMPT,
    });

    const result = await model.generateContent(buildUserPrompt(filePath, content));
    const response = result.response;
    const text = response.text();

    const usage = response.usageMetadata;

    return {
      analysis: parseAnalysisResponse(text, filePath),
      inputTokens: usage?.promptTokenCount ?? 0,
      outputTokens: usage?.candidatesTokenCount ?? 0,
    };
  }

  async analyzeSummary(
    filePath: string,
    content: string,
    symbols: Array<{ name: string; kind: string; signature: string; line?: number | null; end_line?: number }>
  ): Promise<AnalysisResult> {
    const model = this.genAI.getGenerativeModel({
      model: this.model,
      systemInstruction: SUMMARY_ONLY_SYSTEM_PROMPT,
    });

    const result = await model.generateContent(buildSummaryUserPrompt(filePath, content, symbols));
    const response = result.response;
    const text = response.text();
    const usage = response.usageMetadata;

    return {
      analysis: parseAnalysisResponse(text, filePath),
      inputTokens: usage?.promptTokenCount ?? 0,
      outputTokens: usage?.candidatesTokenCount ?? 0,
    };
  }
}
