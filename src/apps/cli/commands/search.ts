import type { Command } from 'commander';
import { loadConfig } from '../../../utils/config.js';
import { CodeIndexDB } from '../../../store/db.js';
import { HybridSearch } from '../../../core/search/hybrid.js';
import { getEmbeddingService, getVectorStore } from '../helpers.js';
import { printSearchResults } from '../format.js';
import type { SearchMode, SearchType } from '../../../types.js';

export function register(program: Command): void {
  program
    .command('search <query>')
    .description('Search across projects')
    .option('-p, --project <name>', 'Project name')
    .option('--mode <mode>', 'Search mode: fts, vector, hybrid', 'hybrid')
    .option('--type <type>', 'Search type: files, symbols, all', 'all')
    .option('-l, --limit <n>', 'Max results', parseInt, 20)
    .option('-g, --global', 'Search all projects')
    .action(async (query: string, opts: { project?: string; mode: string; type: string; limit: number; global?: boolean }) => {
      const config = loadConfig();
      const db = new CodeIndexDB(config.dbPath);
      const embeddingService = getEmbeddingService(config.dbPath);
      const vectorStore = getVectorStore(config.dbPath);
      const search = new HybridSearch(db, vectorStore, embeddingService);

      if (opts.global) {
        const projects = db.listProjects();
        for (const p of projects) {
          const results = await search.search(p.id, p.name, query, {
            mode: opts.mode as SearchMode,
            type: opts.type as SearchType,
            limit: opts.limit,
          });
          if (results.length > 0) {
            console.log(`\n── ${p.name} ──`);
            printSearchResults(results);
          }
        }
      } else {
        const project = db.resolveProject(opts.project);
        const results = await search.search(project.id, project.name, query, {
          mode: opts.mode as SearchMode,
          type: opts.type as SearchType,
          limit: opts.limit,
        });
        printSearchResults(results);
      }
      db.close();
    });
}
