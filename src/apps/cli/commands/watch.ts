import type { Command } from 'commander';
import { loadConfig } from '../../../utils/config.js';
import { CodeIndexDB } from '../../../store/db.js';
import { createProviderAsync } from '../../../core/providers/factory.js';
import { IndexAgent } from '../../../core/indexer/indexer.js';
import { CostTracker } from '../../../core/services/costs.js';
import { WebhookDispatcher } from '../../../core/services/webhooks.js';
import { FileWatcherService } from '../../../core/services/watcher.js';
import { getEmbeddingService, getVectorStore } from '../helpers.js';
import type { ProviderName } from '../../../types.js';

export function register(program: Command): void {
  program.command('watch [project]').description('Watch for file changes')
    .option('--all', 'Watch all projects')
    .option('--daemon', 'Run as daemon')
    .action(async (projectName: string | undefined, opts: { all?: boolean; daemon?: boolean }) => {
      const config = loadConfig();
      const db = new CodeIndexDB(config.dbPath);
      const watcher = new FileWatcherService();
      const provider = await createProviderAsync((config.provider) as ProviderName, config.model);
      const embeddingService = getEmbeddingService(config);
      const vectorStore = getVectorStore(config);
      const costTracker = new CostTracker(db);
      const webhookDispatcher = new WebhookDispatcher(db);
      const agent = new IndexAgent(db, provider, embeddingService, vectorStore, costTracker, webhookDispatcher, config);

      const projectsToWatch = opts.all ? db.listProjects() : (() => {
        if (!projectName) { console.error('Specify project or --all'); process.exit(1); }
        const p = db.getProjectByName(projectName);
        if (!p) { console.error('Project not found'); process.exit(1); }
        return [p];
      })();

      for (const project of projectsToWatch) {
        watcher.startWatching(project.id, {
          rootPath: project.root_path,
          debounce: config.watcher.debounce,
        }, {
          onFileChanged: async (files) => {
            console.log(`[watch] ${project.name}: ${files.length} files changed, re-indexing...`);
            if (config.watcher.autoIndex) {
              await agent.indexProject(project.root_path);
            }
            try {
              await webhookDispatcher.dispatch('watch.changed', project, { files });
            } catch { /* ignore */ }
          },
        });
        console.log(`Watching ${project.name} (${project.root_path})`);
      }

      const shutdown = async () => {
        console.log('\nStopping watchers...');
        await watcher.stopAll();
        db.close();
        process.exit(0);
      };
      process.on('SIGINT', shutdown);
      process.on('SIGTERM', shutdown);

      await new Promise(() => {});
    });
}
