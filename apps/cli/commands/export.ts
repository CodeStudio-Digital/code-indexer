import type { Command } from 'commander';
import { ExportService } from '@mcp/services/services/exporter.js';
import { getDB } from '../helpers.js';
import type { ExportSection } from '@mcp/shared/types.js';

export function register(program: Command): void {
  program.command('export <project>').description('Export documentation')
    .option('-s, --sections <sections>', 'Comma-separated sections')
    .option('-o, --output <path>', 'Output file path')
    .option('--format <fmt>', 'Format: markdown or json', 'markdown')
    .option('--include-snapshots', 'Include snapshots')
    .action((projectName: string, opts: { sections?: string; output?: string; format: string; includeSnapshots?: boolean }) => {
      const db = getDB();
      const svc = new ExportService(db);
      const project = db.getProjectByName(projectName);
      if (!project) { console.error('Project not found'); process.exit(1); }

      const sections = opts.sections?.split(',').map(s => s.trim()) as ExportSection[] | undefined;

      svc.export({
        projectId: project.id,
        projectName: project.name,
        format: opts.format as 'markdown' | 'json',
        sections: sections ?? [],
        outputPath: opts.output,
        includeSnapshots: opts.includeSnapshots ?? false,
        includeCosts: false,
      });
      console.log('Export complete.');
      db.close();
    });
}
