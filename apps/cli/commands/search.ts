import type { Command } from 'commander';
import { loadConfig } from '@mcp/shared/utils/config.js';
import { CodeIndexDB } from '@mcp/store/db.js';
import { HybridSearch } from '@mcp/indexer/search/hybrid.js';
import { NullEmbeddingService } from '@mcp/indexer/search/embeddings.js';
import { printSearchResults } from '../format.js';
import { searchProjectsConcurrently } from '../search-global.js';
import { requestLocalServer } from '../semantic-control.js';
import type { HybridSearchResult, SearchMode, SearchType } from '@mcp/shared/types.js';

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function register(program: Command): void {
  program
    .command('search <query>')
    .description('Search across projects')
    .option('-p, --project <name>', 'Project name')
    .option('--mode <mode>', 'Search mode: auto, fts, vector, hybrid', 'auto')
    .option('--type <type>', 'Search type: files, symbols, all', 'all')
    .option('-l, --limit <n>', 'Max results', parseInt, 20)
    .option('-g, --global', 'Search all projects')
    .action(async (query: string, opts: { project?: string; mode: string; type: string; limit: number; global?: boolean }) => {
      const config = loadConfig();
      const db = new CodeIndexDB(config.dbPath);
      // The short-lived CLI never resolves semantic profiles, opens sqlite-vec,
      // or loads ONNX. The localhost owner handles semantic queries; this local
      // instance exists solely for deterministic FTS fallback.
      const search = new HybridSearch(db, null, new NullEmbeddingService());
      const mode = opts.mode as SearchMode;
      const type = opts.type as SearchType;
      const searchProject = async (project: { id: number; name: string }): Promise<HybridSearchResult[]> => {
        const params = new URLSearchParams({
          q: query,
          mode,
          type,
          limit: String(opts.limit),
        });
        const remote = await requestLocalServer(
          `/api/projects/${project.id}/search?${params}`,
          { method: 'GET' },
          { config, timeoutMs: 20_000 },
        );
        const body = remote.body as { results?: unknown } | null;
        if (remote.ok && Array.isArray(body?.results)) {
          return body.results as HybridSearchResult[];
        }
        // CLI never owns sqlite-vec or ONNX. If the desktop/server owner is
        // unavailable, structural FTS still works deterministically.
        return search.search(project.id, project.name, query, {
          mode: 'fts',
          type,
          limit: opts.limit,
        });
      };

      try {
        if (opts.global) {
          const params = new URLSearchParams({
            q: query,
            mode,
            type,
            limit: String(opts.limit),
          });
          const remote = await requestLocalServer(
            `/api/search?${params}`,
            { method: 'GET' },
            { config, timeoutMs: 20_000 },
          );
          if (remote.ok && Array.isArray(remote.body)) {
            printSearchResults(remote.body as HybridSearchResult[]);
            return;
          }

          // The short-lived CLI never opens sqlite-vec or ONNX. If the owner
          // process is unavailable, fan out structural FTS only.
          const projects = db.listProjects();
          const projectResults = await searchProjectsConcurrently(
            projects,
            (project) => search.search(project.id, project.name, query, {
              mode: 'fts',
              type,
              limit: opts.limit,
            }),
          );
          for (const result of projectResults) {
            if (!result.ok) {
              console.error(`Search failed for ${result.project.name}: ${errorMessage(result.error)}`);
              continue;
            }
            if (result.results.length > 0) {
              console.log(`\n── ${result.project.name} ──`);
              printSearchResults(result.results);
            }
          }
        } else {
          const project = db.resolveProject(opts.project);
          const results = await searchProject(project);
          printSearchResults(results);
        }
      } finally {
        db.close();
      }
    });
}
