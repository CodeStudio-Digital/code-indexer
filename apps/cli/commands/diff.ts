import type { Command } from 'commander';
import { DiffService } from '@mcp/services/services/differ.js';
import { getDB } from '../helpers.js';

export function register(program: Command): void {
  program.command('diff <project>').description('Compare indexing runs')
    .option('--run-before <n>', 'Before run ID', parseInt)
    .option('--run-after <n>', 'After run ID', parseInt)
    .action((projectName: string, opts: { runBefore?: number; runAfter?: number }) => {
      const db = getDB();
      const svc = new DiffService(db);
      const project = db.getProjectByName(projectName);
      if (!project) { console.error('Project not found'); process.exit(1); }

      const diff = opts.runBefore && opts.runAfter
        ? svc.diff(project.id, opts.runBefore, opts.runAfter)
        : svc.diffLatest(project.id);

      if (!diff) { console.log('Not enough runs to compare.'); } else { console.log(svc.formatDiff(diff)); }
      db.close();
    });
}
