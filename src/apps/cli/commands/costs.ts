import type { Command } from 'commander';
import { loadConfig } from '../../../utils/config.js';
import { CostTracker } from '../../../core/services/costs.js';
import { createAndSeedProviderStore } from '../../../core/bootstrap/index.js';
import { getDB } from '../helpers.js';

export function register(program: Command): void {
  const costs = program.command('costs').description('Cost tracking');

  costs.command('show [project]').option('--since <date>', 'Filter since date').action((projectName: string | undefined, opts: { since?: string }) => {
    const db = getDB();
    const tracker = new CostTracker(db);
    if (projectName) {
      const project = db.getProjectByName(projectName);
      if (!project) { console.error('Project not found'); process.exit(1); }
      const summary = tracker.getProjectCosts(project.id, opts.since);
      console.log(JSON.stringify(summary, null, 2));
    } else {
      const summary = tracker.getGlobalCosts(opts.since);
      console.log(JSON.stringify(summary, null, 2));
    }
    db.close();
  });

  costs.command('estimate <project>').option('-p, --provider <name>', 'Provider').option('-m, --model <name>', 'Model')
    .action((projectName: string, opts: { provider?: string; model?: string }) => {
      const db = getDB();
      const config = loadConfig();
      const providerStore = createAndSeedProviderStore(config.dbPath);
      const defaults = providerStore.getDefaultProviderAndModel();
      const embeddingCfg = providerStore.getDefaultEmbedding();
      const tracker = new CostTracker(db);
      const project = db.getProjectByName(projectName);
      if (!project) { console.error('Project not found'); process.exit(1); }
      const stats = db.getStats(project.id);
      const estimate = tracker.estimateCost({
        fileCount: stats.file_count || 100,
        provider: opts.provider ?? defaults.kind,
        model: opts.model ?? defaults.model ?? 'glm-5.1',
        embeddingsEnabled: !!embeddingCfg,
      });
      console.log(`Estimated cost: $${estimate.estimatedCostUsd.toFixed(4)}`);
      console.log(`Analysis tokens: ${estimate.analysisTokens.toLocaleString()}`);
      console.log(`Embedding tokens: ${estimate.embeddingTokens.toLocaleString()}`);
      db.close();
    });
}
