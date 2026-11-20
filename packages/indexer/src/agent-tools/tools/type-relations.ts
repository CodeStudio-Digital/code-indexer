import { defineTool, type McpToolResult } from '../tool.js';
import { withProject } from './_helpers.js';
import { projectRelativePath } from './project-read-path.js';

const pageProperties = {
  limit: { type: 'integer', minimum: 1, maximum: 500 }, offset: { type: 'integer', minimum: 0 },
  format: { type: 'string', enum: ['text', 'json'] }, force_reread: { type: 'boolean' },
};
function input(args: Record<string, unknown>, key: string) {
  const name = args[key], limit = args.limit ?? 100, offset = args.offset ?? 0;
  if (typeof name !== 'string' || !name.trim() || name.length > 1024 || name.includes('\0')) throw new Error('Invalid type name');
  if (typeof limit !== 'number' || !Number.isSafeInteger(limit) || limit < 1 || limit > 500
    || typeof offset !== 'number' || !Number.isSafeInteger(offset) || offset < 0) throw new Error('Invalid type page');
  return { name, page: { limit, offset } };
}
function output(tool: string, args: Record<string, unknown>, total: number, shown: number, offset: number,
  data: Record<string, unknown>, lines: string[], note: string): McpToolResult {
  const next = offset + shown < total ? offset + shown : undefined;
  const omitted = total > shown;
  const recovery = omitted ? { ...args, tool, offset: next ?? 0 } : undefined;
  const text = args.format === 'json'
    ? JSON.stringify({ ...data, total, shown, offset, next_offset: next, truncated: omitted, recovery, note })
    : [...lines, note, ...(recovery ? ['Continue: ' + JSON.stringify(recovery)] : [])].join('\n');
  return omitted ? { text, sourceTruncations: [{ technique: 'mcp-' + tool.replaceAll('_', '-') + '-page',
    inputSize: total, outputSize: shown, unit: 'items', recoverable: true }] } : text;
}
const relationNote = 'Relations are indexed by name; same-named types in different namespaces may share incoming edges. Use LSP to resolve exact types.';

export const findImplementations = defineTool({
  name: 'find_implementations', tier: 'navigate', access: 'read',
  description: 'Page through classes implementing an interface in the structural index, with file and line. Default 100, maximum 500; follow offset for the tail. Relations are name-based, not compiler-resolved. Use get_hierarchy for parents, traits and subclasses.',
  inputSchema: { type: 'object', properties: { project_name: { type: 'string' }, interface_name: { type: 'string' }, ...pageProperties },
    required: ['project_name', 'interface_name'] },
  handler: withProject((args, { db, signal }, project) => {
    signal?.throwIfAborted();
    if (project.is_synthetic) throw new Error('Synthetic projects are unsupported after the filesystem-session cutover');
    const { name, page } = input(args, 'interface_name');
    const result = db.listAgentImplementations(project.id, name, page); signal?.throwIfAborted();
    return output('find_implementations', { project_name: project.name, interface_name: name, ...page, format: args.format },
      result.total, result.items.length, page.offset, { interface_name: name, source: 'index', implementations: result.items },
      result.items.length ? result.items.map(s => `${s.kind} ${s.name} — ${s.file_path}:${s.line ?? '?'}`) : ['No implementations found on this page.'], relationNote);
  }),
});

export const getHierarchy = defineTool({
  name: 'get_hierarchy', tier: 'navigate', access: 'read',
  description: 'Page through indexed parents, traits, subclasses and implementors of a type. Includes a cycle-guarded extends chain up to five hops with an explicit stop reason. Ambiguous definitions require file_path. Default 100 relations, maximum 500; follow offset for all edges. Incoming edges are name-based, not compiler-resolved.',
  inputSchema: { type: 'object', properties: { project_name: { type: 'string' }, symbol_name: { type: 'string' },
    file_path: { type: 'string' }, declaration_line: { type: 'integer', minimum: 1 }, ...pageProperties }, required: ['project_name', 'symbol_name'] },
  handler: withProject((args, { db, signal }, project) => {
    signal?.throwIfAborted();
    if (project.is_synthetic) throw new Error('Synthetic projects are unsupported after the filesystem-session cutover');
    const { name, page } = input(args, 'symbol_name');
    const path = args.file_path == null ? undefined : projectRelativePath(project.root_path, args.file_path);
    const declarationLine = args.declaration_line;
    if (declarationLine != null && (!path || typeof declarationLine !== 'number' || !Number.isSafeInteger(declarationLine) || declarationLine < 1)) throw new Error('Invalid declaration_line; requires file_path and a positive integer');
    const result = db.getAgentTypeHierarchy(project.id, name, path, { ...page, declarationLine: declarationLine as number | undefined }); signal?.throwIfAborted();
    const recoveryArgs = { project_name: project.name, symbol_name: name, ...(path ? { file_path: path } : {}),
      ...(declarationLine == null ? {} : { declaration_line: declarationLine }), ...page, format: args.format };
    if (result.ambiguous) return output('get_hierarchy', recoveryArgs, result.total, result.items.length, page.offset,
      { error: 'ambiguous', symbol_name: name, candidates: result.items },
      [`Ambiguous type '${name}'. Pass file_path and declaration_line to disambiguate.`, ...result.items.map(s => `${s.file_path}:${s.line} ${s.kind} ${s.namespace ?? ''}`)], relationNote);
    const lines = result.items.map(s => `${s.direction === 'parent' ? 'Parent' : 'Child'} (${s.relation}): ${s.name}${s.file_path ? ` — ${s.file_path}:${s.line ?? '?'}` : ''}${s.namespace ? ` [${s.namespace}]` : ''}`);
    if (result.extends_chain.length) lines.unshift('Extends: ' + result.extends_chain.join(' → '));
    if (!lines.length) lines.push('No hierarchy information found on this page.');
    const incomplete = !['complete', 'unindexed'].includes(result.chain_stop);
    const note = relationNote + (result.chain_stop !== 'complete' ? ` Extends chain stopped: ${result.chain_stop}; inspect each parent with get_hierarchy.` : '');
    const rendered = output('get_hierarchy', recoveryArgs, result.total, result.items.length, page.offset,
      { source: 'index', symbol_name: name, symbol: result.symbol, relations: result.items,
        extends_chain: result.extends_chain, chain_stop: result.chain_stop }, lines, note);
    if (!incomplete) return rendered;
    return { ...(typeof rendered === 'string' ? { text: rendered } : rendered), sourceTruncations: [
      ...(typeof rendered === 'string' ? [] : rendered.sourceTruncations ?? []),
      { technique: 'mcp-hierarchy-chain-' + result.chain_stop, inputSize: result.extends_chain.length + 1,
        inputSizeExact: false, outputSize: result.extends_chain.length, unit: 'items', recoverable: true },
    ] };
  }),
});
