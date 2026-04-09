import type { CodeIndexDB } from '../../store/db.js';
import type { CostSummary } from '../../types.js';
import { calculateCost as registryCalculateCost, lookupPricing } from '../providers/pricing.js';

/**
 * Legacy adapter: returns pricing in the old shape {input, output}.
 * Kept for any external consumer that imported PRICING directly.
 * Prefer `lookupPricing(model)` or `calculateCost(...)` from
 * `../providers/pricing.js` for new code.
 *
 * @deprecated Use lookupPricing / calculateCost from providers/pricing.js.
 */
export const PRICING: Record<string, { input: number; output: number }> = new Proxy(
  {} as Record<string, { input: number; output: number }>,
  {
    get(_target, prop: string) {
      const p = lookupPricing(prop);
      return { input: p.inputPer1M, output: p.outputPer1M };
    },
  },
);

export class CostTracker {
  constructor(private db: CodeIndexDB) {}

  calculateCost(model: string, inputTokens: number, outputTokens: number): number {
    return registryCalculateCost(model, inputTokens, outputTokens);
  }

  record(params: {
    projectId: number;
    runId?: number;
    provider: string;
    model: string;
    operation: 'analysis' | 'embedding';
    filePath?: string;
    inputTokens: number;
    outputTokens: number;
  }): number {
    const costUsd = this.calculateCost(params.model, params.inputTokens, params.outputTokens);
    this.db.insertCost({ ...params, costUsd });
    return costUsd;
  }

  getProjectCosts(projectId: number, since?: string): CostSummary {
    return this.db.getCostSummary(projectId, since);
  }

  getGlobalCosts(since?: string): CostSummary {
    return this.db.getGlobalCostSummary(since);
  }

  getRunCost(runId: number) {
    return this.db.getRunCostSummary(runId);
  }

  estimateCost(params: {
    fileCount: number;
    avgFileSizeTokens?: number;
    provider: string;
    model: string;
    embeddingsEnabled?: boolean;
  }): { analysisTokens: number; embeddingTokens: number; estimatedCostUsd: number } {
    const avgTokens = params.avgFileSizeTokens ?? 1500;
    const systemTokens = 500;
    const outputTokensPerFile = 800;
    const embeddingTokensPerFile = 300;

    const totalInputTokens = params.fileCount * (avgTokens + systemTokens);
    const totalOutputTokens = params.fileCount * outputTokensPerFile;
    const totalEmbeddingTokens = params.embeddingsEnabled ? params.fileCount * embeddingTokensPerFile : 0;

    const analysisCost = this.calculateCost(params.model, totalInputTokens, totalOutputTokens);
    const embeddingCost = params.embeddingsEnabled
      ? this.calculateCost('@cf/baai/bge-m3', totalEmbeddingTokens, 0)
      : 0;

    return {
      analysisTokens: totalInputTokens + totalOutputTokens,
      embeddingTokens: totalEmbeddingTokens,
      estimatedCostUsd: analysisCost + embeddingCost,
    };
  }
}
