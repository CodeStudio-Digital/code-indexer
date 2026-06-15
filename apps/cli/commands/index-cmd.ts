import type { Command } from 'commander';
import { resolve } from 'node:path';
import { loadConfig } from '@mcp/shared/utils/config.js';
import { CodeIndexDB } from '@mcp/store/db.js';
import { createProviderAsync } from '@mcp/services/providers/factory.js';
import { IndexAgent } from '@mcp/indexer/indexer/indexer.js';
import { CostTracker } from '@mcp/services/services/costs.js';
import { WebhookDispatcher } from '@mcp/services/services/webhooks.js';
import { getEmbeddingService, getVectorStore } from '../helpers.js';
import { createAndSeedProviderStore } from '@mcp/indexer/bootstrap/index.js';
import { disposeIndexerProcessResources } from '@mcp/indexer/bootstrap/dispose.js';
import type { ProviderName } from '@mcp/shared/types.js';
import type { IndexProfile } from '@mcp/shared/utils/config.js';

const PROFILES: IndexProfile[] = ['aggressive', 'balanced', 'conservative'];

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
    .option('--profile <name>', 'Indexer profile: aggressive | balanced | conservative')
    .action(async (path: string | undefined, opts: { provider?: string; model?: string; concurrency?: number; force?: boolean; budget?: number; embeddingsOnly?: boolean; profile?: string }) => {
      const config = loadConfig();
      if (opts.budget !== undefined) config.budget = opts.budget;
      if (opts.profile) {
        if (!PROFILES.includes(opts.profile as IndexProfile)) {
          console.error(`Invalid profile "${opts.profile}". Use one of: ${PROFILES.join(', ')}`);
          process.exit(1);
        }
        config.indexProfile = opts.profile as IndexProfile;
      }
      const db = new CodeIndexDB(config.dbPath);
      // The worker pools keep the event loop alive — without the dispose in
      // `finally` the CLI process would hang after the run (workers default ON).
      try {
        const embeddingService = getEmbeddingService(config.dbPath);
        const vectorStore = getVectorStore(config.dbPath);
        const costTracker = new CostTracker(db);
        const webhookDispatcher = new WebhookDispatcher(db);
        const projectPath = resolve(path ?? process.cwd());

        if (opts.embeddingsOnly) {
          // Embeddings-only mode: no LLM provider needed, just retry
          // failed/missing embeddings using data already in the DB.
          const dummyProvider = { name: 'none', model: 'none', analyzeFile: () => { throw new Error('not used'); } } as unknown as import('@mcp/indexer/indexer/providers/base.js').LLMProvider;
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
          return;
        }

        const providerStore = createAndSeedProviderStore(config.dbPath);
        const defaults = providerStore.getDefaultProviderAndModel();
        // No explicit provider → pass undefined so the factory resolves the
        // default ProviderStore row with its stored credentials/base_url
        // (passing `defaults.kind` would strip them and fall back to env vars).
        const provider = await createProviderAsync(opts.provider as ProviderName | undefined, opts.model ?? defaults.model);
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
      } finally {
        await disposeIndexerProcessResources();
        db.close();
      }
    });
}
