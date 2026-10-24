import { defineTool, mcpAccess, type McpToolResult } from '../tool.js';
import { normalizeFilePath, withProject } from './_helpers.js';

const indexPageSchema = {
  offset: { type: 'number' as const, description: 'Result offset, default 0. Restart from 0 after index changes.' },
  limit: { type: 'number' as const, description: 'Page size, default 200, maximum 500.' },
};
export function indexPageArgs(args: Record<string, unknown>, fallback = 200) {
  const offset = args.offset == null ? 0 : Number(args.offset), limit = args.limit == null ? fallback : Number(args.limit);
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1) throw new Error('offset must be non-negative and limit positive integers');
  return { offset, limit: Math.min(limit, 500) };
}
function indexPageResult(name: string, args: Record<string, unknown>, page: { total: number; offset: number; nextOffset?: number; items: unknown[] }, text: string, empty: string): McpToolResult {
  if (page.offset > page.total) throw new Error('Offset exceeds current results; restart from offset 0 after index changes');
  const more = page.nextOffset != null;
  const partial = more || page.offset > 0;
  const content = [partial ? `Showing ${page.items.length} of ${page.total} results at offset ${page.offset}.` : '', text || (page.total ? 'No remaining results.' : empty),
    more ? `Continue: mcp__${name}(${JSON.stringify({ ...args, offset: page.nextOffset })}). Restart at offset 0 after index changes.` : ''].filter(Boolean).join('\n');
  return partial ? { text: content, sourceTruncations: [{ technique: 'mcp-index-result-page', inputSize: page.total, outputSize: page.items.length, unit: 'items', recoverable: true }] } : content;
}

export const indexNavigationTools = [
  defineTool({ name: 'get_recently_modified_files', tier: 'navigate', ...mcpAccess('read'),
    description: 'Page through recently modified indexed files, newest first. Default 20, maximum 500. Timestamp, path and line count are returned; use offset to continue.',
    inputSchema: { type: 'object', properties: { project_name: { type: 'string' }, ...indexPageSchema }, required: ['project_name'] },
    handler: withProject((args, ctx, project) => {
      ctx.signal?.throwIfAborted();
      const page = ctx.db.listAgentIndexFiles(project.id, { ...indexPageArgs(args, 20), order: 'updated' });
      ctx.signal?.throwIfAborted();
      return indexPageResult('get_recently_modified_files', args, page, page.items.map(f => `${f.updated_at} ${f.path} (${f.line_count}L)`).join('\n'), 'No files.');
    }),
  }),
  dependencyTool('dependencies'), dependencyTool('dependents'),
];

function dependencyTool(op: 'dependencies' | 'dependents') {
  const name = `get_${op}`;
  return defineTool({ name: `get_${op}`, tier: 'navigate', ...mcpAccess('read'),
    description: (name === 'get_dependencies' ? 'Page through the imports of a file, with resolved in-project targets.' : 'Page through the files that import this file (reverse dependencies).') + ' Default 200, maximum 500. Use offset to continue.',
    inputSchema: { type: 'object', properties: { project_name: { type: 'string' }, file_path: { type: 'string' }, ...indexPageSchema }, required: ['project_name', 'file_path'] },
    handler: withProject((args, ctx, project) => {
      ctx.signal?.throwIfAborted();
      if (typeof args.file_path !== 'string' || !args.file_path.trim()) throw new Error('file_path is required');
      const filePath = normalizeFilePath(args.file_path, project.root_path), file = ctx.db.getFile(project.id, filePath);
      if (!file) throw new Error(`File "${filePath}" not found in index. Use list_directory or search to find the correct path.`);
      const page = ctx.db.listAgentIndexDependencies(project.id, file.id, name === 'get_dependents', indexPageArgs(args));
      ctx.signal?.throwIfAborted();
      return indexPageResult(name, args, page, page.items.map(d => 'source_file_path' in d
        ? `${d.source_file_path} (${d.import_path})` : `${d.dep_type} ${d.import_path}${d.target_file_path ? ` → ${d.target_file_path}` : ''}`).join('\n'), 'No ' + name.slice(4) + ' found.');
    }),
  });
}
