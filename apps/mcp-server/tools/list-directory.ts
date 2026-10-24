import { defineTool, mcpAccess } from '../tool.js';
import { withProject } from './_helpers.js';
import { projectRelativePath } from './project-read-path.js';
import { diskDirectoryPage } from './directory-page.js';

export const listDirectory = defineTool({
  name: 'list_directory', tier: 'bootstrap', ...mcpAccess('read'),
  description: 'List a page of files under a project directory (default 500 entries). Uses bounded index metadata, or streams the disk when no indexed rows match. Follow offset for the tail. Disk pages use filesystem order; restart at zero if files change.',
  inputSchema: { type: 'object', properties: {
    project_name: { type: 'string' }, path: { type: 'string' }, depth: { type: 'integer', minimum: 0, maximum: 20 },
    offset: { type: 'integer', minimum: 0 }, limit: { type: 'integer', minimum: 1, maximum: 500 },
  }, required: ['project_name'] },
  handler: withProject(async (args, { db, signal }, project) => {
    signal?.throwIfAborted();
    if (project.is_synthetic) throw new Error('Synthetic projects are unsupported after the filesystem-session cutover');
    const prefix = projectRelativePath(project.root_path, args.path ?? '');
    const depth = args.depth ?? 2, offset = args.offset ?? 0, limit = args.limit ?? 500;
    for (const [name, value, min, max] of [['depth', depth, 0, 20], ['offset', offset, 0, Number.MAX_SAFE_INTEGER], ['limit', limit, 1, 500]] as const) {
      if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) throw new Error(`Invalid ${name}`);
    }
    const index = db.listAgentDirectoryFiles(project.id, prefix, depth as number, { offset: offset as number, limit: limit as number });
    signal?.throwIfAborted();
    const fromIndex = index.total > 0;
    const page = fromIndex
      ? { ...index, items: index.items.map(f => `${f.path} (${f.line_count}L)`), totalExact: true }
      : await diskDirectoryPage(project.root_path, prefix, depth as number, offset as number, limit as number, signal);
    signal?.throwIfAborted();
    const omitted = page.total > page.items.length;
    let text = (fromIndex ? '' : '[disk fallback — index has no entries for this path]\n') + (page.items.join('\n') || 'Empty.');
    if (omitted) {
      text += fromIndex ? `\n... [showing ${page.items.length} of ${page.total} indexed files]`
        : `\n... [disk scan capped at ${limit} entries; total ${page.totalExact === false ? 'at least ' : ''}${page.total}]`;
      text += '\nContinue: ' + JSON.stringify({ tool: 'list_directory', project_name: project.name, path: prefix,
        depth, offset: page.nextOffset ?? 0, limit });
      return { text, sourceTruncations: [{ technique: fromIndex ? 'mcp-list-directory-index-page' : 'mcp-list-directory-disk-scan-cap',
        inputSize: page.total, ...(page.totalExact === false ? { inputSizeExact: false } : {}),
        outputSize: page.items.length, unit: 'items' as const, recoverable: true }] };
    }
    return text;
  }),
});
