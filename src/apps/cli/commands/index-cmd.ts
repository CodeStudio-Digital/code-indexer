import type { Command } from 'commander';
import { resolve } from 'node:path';
import { loadConfig } from '../../../utils/config.js';
import { CodeIndexDB } from '../../../store/db.js';
import { createProviderAsync } from '../../../core/providers/factory.js';
import { IndexAgent } from '../../../core/indexer/indexer.js';
import { CostTracker } from '../../../core/services/costs.js';
import { WebhookDispatcher } from '../../../core/services/webhooks.js';
import { getEmbeddingService, getVectorStore } from '../helpers.js';
import type { ProviderName } from '../../../types.js';

export function register(program: Command): void {
  program
    .command('index [path]')
    .description('Index a project')
    .option('-p, --provider <name>', 'LLM provider')
    .option('-m, --model <name>', 'LLM model')
    .option('-c, --concurrency <n>', 'Concurrency limit', parseInt)
    .option('-f, --force', 'Force reindex all files')
    .option('-b, --budget <amount>', 'Budget limit in USD', parseFloat)
    .option('-e, --embeddings-only', 'Retry only failed/missing embeddings (skip LLM analysis)')
    .action(async (path: string | undefined, opts: { provider?: string; model?: string; concurrency?: number; force?: boolean; budget?: number; embeddingsOnly?: boolean }) => {
      const config = loadConfig();
      if (opts.budget !== undefined) config.budget = opts.budget;
      const db = new CodeIndexDB(config.dbPath);
      const embeddingService = getEmbeddingService(config);
      const vectorStore = getVectorStore(config);
      const costTracker = new CostTracker(db);
      const webhookDispatcher = new WebhookDispatcher(db);
      const projectPath = resolve(path ?? process.cwd());

      if (opts.embeddingsOnly) {
        // Embeddings-only mode: no LLM provider needed, just retry
        // failed/missing embeddings using data already in the DB.
        const dummyProvider = { name: 'none', model: 'none', analyzeFile: () => { throw new Error('not used'); } } as unknown as import('../../../core/indexer/providers/base.js').LLMProvider;
        const agent = new IndexAgent(db, dummyProvider, embeddingService, vectorStore, costTracker, webhookDispatcher, config);

        console.log(`Retrying embeddings for ${projectPath}...`);
        const startTime = Date.now();

        const result = await agent.retryEmbeddings(projectPath, {
          onProgress: (p) => {
            process.stderr.write(`\r[embeddings] ${p.current}/${p.total} (${p.percent}%)`);
          },
        });

        console.log('\n');
        console.log(`Done in ${((Date.now() - startTime) / 1000).toFixed(1)}s`);
        console.log(`Embedded: ${result.embedded}, Skipped: ${result.skipped}, Tokens: ${result.tokens}`);
        db.close();
        return;
      }

      const provider = await createProviderAsync((opts.provider ?? config.provider) as ProviderName, opts.model ?? config.model);
      const agent = new IndexAgent(db, provider, embeddingService, vectorStore, costTracker, webhookDispatcher, config);

      console.log(`Indexing ${projectPath} with ${provider.name}/${provider.model}...`);
      const startTime = Date.now();

      const result = await agent.indexProject(projectPath, {
        force: opts.force,
        concurrency: opts.concurrency,
        onProgress: (p) => {
          process.stderr.write(`\r[${p.current}/${p.total}] ${p.currentFile.padEnd(60)} $${p.costUsd.toFixed(4)}`);
        },
      });

      console.log('\n');
      console.log(`Done in ${((Date.now() - startTime) / 1000).toFixed(1)}s`);
      console.log(`Files: ${result.indexedFiles} indexed, ${result.skippedFiles} skipped, ${result.errorCount} errors`);
      console.log(`Cost: $${result.costUsd.toFixed(4)}`);
      db.close();
    });
}
