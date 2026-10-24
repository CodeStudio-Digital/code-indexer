import type { CodeIndexDB } from '@mcp/store/db.js';
import type { ExportOptions, ExportSection } from '@mcp/shared/types.js';
import { exportSections, readExportData } from './export-source.js';
import { renderExport } from './export-render.js';
import { exportOutputPath, publishExport } from './export-publish.js';

export class ExportService {
  constructor(private db: CodeIndexDB) {}

  async export(options: ExportOptions, signal?: AbortSignal, assertCurrent?: () => void): Promise<string> {
    signal?.throwIfAborted();
    const sections = exportSections(options);
    const path = exportOutputPath(options);
    const data = await readExportData(this.db, options, sections, signal);
    const output = await renderExport(data, options, sections, signal);
    await publishExport(path, output, signal, assertCurrent);
    return output;
  }

  /** Native calls select their project from the Host owner; model-supplied
   * project names, IDs and output paths never select the persistence target. */
  exportProject(projectId: number, input: Record<string, unknown>, control: { signal: AbortSignal; assertCurrent(): void }): Promise<string> {
    control.assertCurrent();
    const project = this.db.getProject(projectId);
    if (!project) throw new Error('Export requires an existing project');
    return this.export({ projectId, projectName: project.name,
      format: (input.format ?? 'markdown') as ExportOptions['format'], sections: (input.sections ?? []) as ExportSection[],
      includeSnapshots: true, includeCosts: false }, control.signal, control.assertCurrent);
  }
}
