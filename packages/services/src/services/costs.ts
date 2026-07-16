import type { CodeIndexDB } from '@mcp/store/db.js';
import type { CostSummary } from '@mcp/shared/types.js';
import { calculateCost } from '../providers/pricing.js';

export class CostTracker {
  constructor(private db: CodeIndexDB) {}

  record(params: {
    projectId: number;
    runId?: number;
    provider: string;
    model: string;
    operation: 'embedding';
    filePath?: string;
    inputTokens: number;
    outputTokens: number;
  }): number {
    const costUsd = calculateCost(params.model, params.inputTokens, params.outputTokens);
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
}
