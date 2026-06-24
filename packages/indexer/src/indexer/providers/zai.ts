import { OpenAIProvider } from '@mcp/indexer/indexer/providers/openai.js';
import type { LLMProvider } from '@mcp/indexer/indexer/providers/base.js';
import type { AnalysisResult } from '@mcp/shared/types.js';

/**
 * Z.AI offers two endpoints (`paas/v4` general vs `coding/paas/v4`
 * Coding Plan). The coding endpoint is paid and rejects standard API
 * keys, so the safe default is the general one — every supported model
 * works there. Operators on the Coding Plan can override via
 * `ZAI_BASE_URL` or by setting `base_url` on the provider config.
 *
 * The previous heuristic auto-routed glm-5.1/turbo/codegeex through the
 * coding URL, which broke every indexer run for users without the
 * Coding Plan. We removed it; explicit opt-in is the right knob.
 */
const ZAI_GENERAL_URL = 'https://api.z.ai/api/paas/v4/';

function resolveBaseURL(_model: string, baseURL?: string): string {
  if (baseURL) return baseURL;
  if (process.env.ZAI_BASE_URL) return process.env.ZAI_BASE_URL;
  return ZAI_GENERAL_URL;
}

export class ZAIProvider implements LLMProvider {
  readonly name = 'zai';
  readonly model: string;
  private inner: OpenAIProvider;

  constructor(apiKey?: string, model?: string, baseURL?: string) {
    this.model = model ?? 'glm-5.1';
    this.inner = new OpenAIProvider(
      apiKey,
      this.model,
      resolveBaseURL(this.model, baseURL)
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
