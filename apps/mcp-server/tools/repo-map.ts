import { defineTool, mcpAccess, type McpSourceTruncation } from '../tool.js';
import { withProject } from './_helpers.js';
import { renderRepoMap } from '@mcp/services/services/repo-map.js';
import { truncateToTokensDetailed } from '../utils.js';

export const getRepoMap = defineTool({
  name: 'get_repo_map', tier: 'navigate', ...mcpAccess('read'),
  description: 'Page through an architecture map ranked by dependency hubs, entrypoint-like paths and symbol richness. Default 100 files, max 500; each shows up to three supported symbols with short signatures. Recover complete outlines with get_file_skeleton/read_file. Use offset for remaining files and restart after index changes. max_tokens optionally shortens text only; JSON preserves the structured page.',
  inputSchema: { type: 'object', properties: {
    project_name: { type: 'string' }, offset: { type: 'integer', minimum: 0 }, limit: { type: 'integer', minimum: 1, maximum: 500 },
    max_tokens: { type: 'integer', minimum: 1, maximum: 100000 }, format: { type: 'string', enum: ['text', 'json'] },
  }, required: ['project_name'] },
  handler: withProject((args, { db, signal }, project) => {
    signal?.throwIfAborted();
    if (project.is_synthetic) throw new Error('Synthetic projects are unsupported after the filesystem-session cutover');
    const offset = args.offset ?? 0, limit = args.limit ?? 100, budget = args.max_tokens;
    if (typeof offset !== 'number' || typeof limit !== 'number') throw new Error('Invalid repo map page');
    if (budget != null && (typeof budget !== 'number' || !Number.isSafeInteger(budget) || budget < 1 || budget > 100000)) throw new Error('Invalid map token budget');
    if (args.format === 'json' && budget != null) throw new Error('max_tokens applies to text only; reduce limit for JSON pages');
    const page = db.listAgentRepoMap(project.id, { offset, limit }); signal?.throwIfAborted();
    const sourceTruncations: McpSourceTruncation[] = [];
    const recovery = page.items.length < page.total ? { tool: 'get_repo_map', project_name: project.name, offset: page.nextOffset ?? 0, limit, format: args.format } : undefined;
    if (recovery) sourceTruncations.push({ technique: 'mcp-repo-map-file-page', inputSize: page.total, outputSize: page.items.length, unit: 'items', recoverable: true });
    const symbolTotal = page.items.reduce((n, f) => n + f.symbol_count, 0), symbolShown = page.items.reduce((n, f) => n + f.symbols.length, 0);
    if (symbolShown < symbolTotal) sourceTruncations.push({ technique: 'mcp-repo-map-symbol-preview', inputSize: symbolTotal, outputSize: symbolShown, unit: 'items', recoverable: true });
    const shortened = page.items.flatMap(f => f.symbols).filter(s => s.signature_characters > 80);
    if (shortened.length) sourceTruncations.push({ technique: 'mcp-repo-map-signature-preview',
      inputSize: shortened.reduce((n, s) => n + s.signature_characters, 0), outputSize: shortened.reduce((n, s) => n + Array.from(s.signature).length, 0), unit: 'chars', recoverable: true });
    let text: string;
    if (args.format === 'json') text = JSON.stringify({ total: page.total, shown: page.items.length, offset, next_offset: page.nextOffset, recovery,
      files: page.items.map(({ id: _id, ...file }) => ({ ...file, symbols_recovery: { tool: 'get_file_skeleton', project_name: project.name, file_path: file.path },
        signature_recovery: 'read_file at the declaration line' })), note: 'Structural ranking; symbols are previews of supported kinds, not a full outline.' });
    else {
      const complete = renderRepoMap(page), limited = truncateToTokensDetailed(complete, budget as number | undefined);
      text = limited.text;
      if (limited.truncated) sourceTruncations.push({ technique: 'mcp-repo-map-token-budget', inputSize: limited.inputChars, outputSize: limited.retainedChars, unit: 'chars', recoverable: true });
    }
    return sourceTruncations.length ? { text, sourceTruncations } : text;
  }),
});
