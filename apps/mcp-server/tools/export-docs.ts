import type { ExportSection } from '@mcp/shared/types.js';
import { resolveProject } from '@mcp/indexer/agent-tools/utils.js';
import { defineTool, mcpAccess } from '../tool.js';

/** Application/CLI export surface; uses the server-only ExportService. */
export const export_docs = defineTool({
  name: 'export_docs',
  tier: 'admin',
  ...mcpAccess('admin'),
  description:
    'Export structural project documentation (overview, directory tree, files, symbols and optional snapshots) as one document.\n' +
    'Default format is markdown; pass format="json" for structured output, and sections to limit which parts are included.',
  inputSchema: {
    type: 'object',
    properties: {
      project_name: { type: 'string' },
      format: { type: 'string', enum: ['markdown', 'json'] },
      sections: { type: 'array', items: { type: 'string', enum: ['overview', 'architecture', 'files', 'symbols', 'api', 'snapshots'] } },
    },
    required: ['project_name'],
  },
  handler: (args, { db, exportService, signal }) => {
    const project = resolveProject(db, args.project_name as string);
    return exportService.export({
      projectId: project.id,
      projectName: project.name,
      format: (args.format as 'markdown' | 'json') ?? 'markdown',
      sections: (args.sections as ExportSection[]) ?? [],
      includeSnapshots: true,
      includeCosts: false,
    }, signal);
  },
});
