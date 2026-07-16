import type { Command } from 'commander';
import { CostTracker } from '@mcp/services/services/costs.js';
import { getDB } from '../helpers.js';

export function register(program: Command): void {
  const costs = program
    .command('costs')
    .description('Read the historical provider-cost ledger (local indexing and ONNX inference cost $0)');

  costs
    .command('show [project]')
    .option('--since <date>', 'Filter since date')
    .action((projectName: string | undefined, opts: { since?: string }) => {
      const db = getDB();
      try {
        const tracker = new CostTracker(db);
        if (projectName) {
          const project = db.getProjectByName(projectName);
          if (!project) {
            console.error('Project not found');
            process.exitCode = 1;
            return;
          }
          console.log(JSON.stringify(tracker.getProjectCosts(project.id, opts.since), null, 2));
          return;
        }
        console.log(JSON.stringify(tracker.getGlobalCosts(opts.since), null, 2));
      } finally {
        db.close();
      }
    });
}
