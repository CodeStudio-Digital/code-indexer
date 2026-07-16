import type { Command } from 'commander';
import { basename, resolve } from 'node:path';
import { loadConfig } from '@mcp/shared/utils/config.js';
import { CodeIndexDB } from '@mcp/store/db.js';
import { requestLocalServer } from '../semantic-control.js';

export function register(program: Command): void {
  program
    .command('index [path]')
    .description('Reconcile structural data and start semantic indexing for one project')
    .option('--structural-only', 'Stop after files, symbols, references, dependencies and FTS are ready')
    .option('--rebuild-semantic', 'Build a replacement semantic generation instead of starting/catching up')
    .action(async (
      path: string | undefined,
      opts: { structuralOnly?: boolean; rebuildSemantic?: boolean },
    ) => {
      const config = loadConfig();
      const db = new CodeIndexDB(config.dbPath);
      try {
        const projectPath = resolve(path ?? process.cwd());
        let project = db.getProjectByPath(projectPath);
        if (!project) {
          const created = await requestLocalServer('/api/projects', {
            method: 'POST',
            body: JSON.stringify({ name: basename(projectPath), root_path: projectPath }),
          }, { config });
          if (!created.ok) {
            throw new Error(
              `Project is not registered and the owner server could not create it: ${created.error ?? 'unavailable'}`,
            );
          }
          project = created.body as typeof project;
        }
        if (!project?.id) throw new Error(`Unable to resolve project for ${projectPath}`);

        console.log(`Reconciling structural index for ${project.name}...`);
        const structuralResponse = await requestLocalServer(
          `/api/projects/${project.id}/index/structural/reconcile`,
          { method: 'POST' },
          { config, timeoutMs: 190_000 },
        );
        if (!structuralResponse.ok) {
          throw new Error(
            `The local server must own structural indexing: ${structuralResponse.error ?? 'server unavailable'}`,
          );
        }
        const structural = structuralResponse.body as {
          ok?: boolean;
          readiness?: { status?: string; phase?: string };
          status?: { phase?: string };
        } | null;
        const structuralState = structural?.status?.phase
          ?? structural?.readiness?.phase
          ?? structural?.readiness?.status
          ?? 'ready';
        console.log(`Structural index: ${structuralState}.`);
        if (structural?.ok === false) {
          console.log('Semantic indexing was not started because structural reconciliation is still incomplete.');
          return;
        }
        if (opts.structuralOnly) return;

        const action = opts.rebuildSemantic ? 'rebuild' : 'start';
        const semanticResponse = await requestLocalServer(
          `/api/projects/${project.id}/semantic/reindex`,
          { method: 'POST', body: JSON.stringify({ action }) },
          { config, timeoutMs: 10_000 },
        );
        if (!semanticResponse.ok) {
          console.warn(
            `Semantic indexing was not started: ${semanticResponse.error ?? 'profile disabled or worker unavailable'}. `
            + 'Structural search and FTS remain available.',
          );
          return;
        }
        const semantic = semanticResponse.body as { job?: { id?: number; status?: string } } | null;
        const job = semantic?.job?.id ? ` job #${semantic.job.id}` : '';
        console.log(`Semantic ${action}${job} accepted; progress continues in the background worker.`);
      } finally {
        db.close();
      }
    });
}
