import { GoogleGenerativeAI } from '@google/generative-ai';
import type { LLMProvider } from './base.js';
import { SYSTEM_PROMPT, SUMMARY_ONLY_SYSTEM_PROMPT, buildUserPrompt, buildSummaryUserPrompt, parseAnalysisResponse } from './base.js';
import type { AnalysisResult } from '../../../types.js';
import {
  createAuthClient,
  generateContent as cloudCodeGenerate,
} from '../../services/cloudcode.js';

export class GeminiProvider implements LLMProvider {
  readonly name = 'gemini';
  readonly model: string;
  private genAI: GoogleGenerativeAI | null = null;
  /** CloudCode OAuth state — when set, routes through cloudcode-pa.googleapis.com. */
  private cloudCode: {
    authClient: ReturnType<typeof createAuthClient>;
    projectId: string;
  } | null = null;

  constructor(apiKey?: string, model?: string, accessToken?: string, refreshToken?: string | null, projectId?: string) {
    this.model = model ?? 'gemini-2.0-flash';
    if (accessToken) {
      this.cloudCode = {
        authClient: createAuthClient(accessToken, refreshToken),
        projectId: projectId ?? '',
      };
    } else {
      this.genAI = new GoogleGenerativeAI(apiKey ?? process.env.GEMINI_API_KEY ?? '');
    }
  }

  async analyzeFile(filePath: string, content: string): Promise<AnalysisResult> {
    if (this.cloudCode) {
      const res = await cloudCodeGenerate(
        this.cloudCode.authClient,
        this.cloudCode.projectId,
        this.model,
        SYSTEM_PROMPT,
        buildUserPrompt(filePath, content),
      );
      return {
        analysis: parseAnalysisResponse(res.text, filePath),
        inputTokens: res.inputTokens,
        outputTokens: res.outputTokens,
      };
    }
    const model = this.genAI!.getGenerativeModel({ model: this.model, systemInstruction: SYSTEM_PROMPT });
    const result = await model.generateContent(buildUserPrompt(filePath, content));
    const response = result.response;
    const usage = response.usageMetadata;
    return {
      analysis: parseAnalysisResponse(response.text(), filePath),
      inputTokens: usage?.promptTokenCount ?? 0,
      outputTokens: usage?.candidatesTokenCount ?? 0,
    };
  }

  async analyzeSummary(
    filePath: string,
    content: string,
    symbols: Array<{ name: string; kind: string; signature: string; line?: number | null; end_line?: number }>
  ): Promise<AnalysisResult> {
    if (this.cloudCode) {
      const res = await cloudCodeGenerate(
        this.cloudCode.authClient,
        this.cloudCode.projectId,
        this.model,
        SUMMARY_ONLY_SYSTEM_PROMPT,
        buildSummaryUserPrompt(filePath, content, symbols),
      );
      return {
        analysis: parseAnalysisResponse(res.text, filePath),
        inputTokens: res.inputTokens,
        outputTokens: res.outputTokens,
      };
    }
    const model = this.genAI!.getGenerativeModel({ model: this.model, systemInstruction: SUMMARY_ONLY_SYSTEM_PROMPT });
    const result = await model.generateContent(buildSummaryUserPrompt(filePath, content, symbols));
    const response = result.response;
    const usage = response.usageMetadata;
    return {
      analysis: parseAnalysisResponse(response.text(), filePath),
      inputTokens: usage?.promptTokenCount ?? 0,
      outputTokens: usage?.candidatesTokenCount ?? 0,
    };
  }
}
