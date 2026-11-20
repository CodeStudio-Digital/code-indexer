import { defineTool } from '../tool.js';
import { projectRelativePath } from './project-read-path.js';
import { readProjectFile } from './project-file-read.js';
import { treeSitterSymbols } from '@mcp/indexer/indexer/incremental.js';

export const semanticNeighbors = defineTool({
  name: 'semantic_neighbors', tier: 'navigate', access: 'read',
  description: 'Find between 1 and 50 semantically related symbols (default 10). Use project_name + symbol_name, optionally file_path to disambiguate; legacy symbol_id is also accepted. A bounded current-body excerpt and structural metadata form the query; missing/large files use structural context. Embedding/vector work runs in the semantic owner process; unavailable vectors return explicitly labelled lexical fallback. Results are verified against the same project index and deleted/foreign symbols are excluded.',
  inputSchema: { type: 'object', properties: {
    project_name: { type: 'string' }, symbol_id: { type: 'integer', minimum: 1 }, symbol_name: { type: 'string' },
    file_path: { type: 'string' }, candidate_offset: { type: 'integer', minimum: 0 },
    limit: { type: 'integer', minimum: 1, maximum: 50 }, format: { type: 'string', enum: ['text', 'json'] }, force_reread: { type: 'boolean' },
  } },
  handler: async (args, { db, semanticSearchClient, hybridSearch, signal }) => {
    signal?.throwIfAborted();
    let id = args.symbol_id; const limit = args.limit ?? 10, name = args.symbol_name, candidateOffset = args.candidate_offset ?? 0;
    if ((id != null && (typeof id !== 'number' || !Number.isSafeInteger(id) || id < 1))
      || typeof limit !== 'number' || !Number.isSafeInteger(limit) || limit < 1 || limit > 50) throw new Error('Invalid symbol_id or neighbor limit (1..50)');
    if (name != null && (typeof name !== 'string' || !name.trim() || name.length > 1024)) throw new Error('Invalid symbol_name');
    if (id == null && name == null) throw new Error('Provide symbol_name or symbol_id');
    if (typeof candidateOffset !== 'number' || !Number.isSafeInteger(candidateOffset) || candidateOffset < 0) throw new Error('Invalid candidate_offset');
    if (args.project_name != null && (typeof args.project_name !== 'string' || !args.project_name.trim())) throw new Error('Invalid project_name');
    const requested = args.project_name == null ? undefined : db.getProjectByName(args.project_name as string);
    if (args.project_name != null && !requested) throw new Error('Project not found; no fallback to another project is allowed');
    if ((id == null || args.file_path != null) && !requested) throw new Error('project_name is required for symbol_name/file_path');
    const path = args.file_path == null ? undefined : projectRelativePath(requested!.root_path, args.file_path);
    if (id == null) {
      const selected = db.listAgentSymbolDefinitions(requested!.id, name as string, path, { offset: 0, limit: 10 });
      if (selected.total > 1) {
        const page = candidateOffset ? db.listAgentSymbolDefinitions(requested!.id, name as string, path, { offset: candidateOffset, limit: 10 }) : selected;
        const next = candidateOffset + page.items.length < page.total ? candidateOffset + page.items.length : undefined;
        const recovery = { tool: 'semantic_neighbors', project_name: requested!.name, symbol_name: name, file_path: path,
          candidate_offset: next ?? 0, format: args.format };
        const text = JSON.stringify({ error: 'ambiguous', total: page.total, candidates: page.items, recovery,
          note: 'Pass a candidate symbol_id or a unique file_path.' });
        return page.total > page.items.length ? { text, sourceTruncations: [{ technique: 'mcp-semantic-neighbor-candidates',
          inputSize: page.total, outputSize: page.items.length, unit: 'items' as const, recoverable: true }] } : text;
      }
      id = selected.items[0]?.id;
    }
    const seed = typeof id === 'number' ? db.getAgentSemanticSeed(id, requested?.id) : undefined;
    if (!seed || (requested && seed.project_id !== requested.id)) throw new Error(`Symbol ${name == null ? `with id ${id}` : JSON.stringify(name)} not found in this project. Use search or get_file_skeleton to refresh the name/file. Do not retry with the same arguments.`);
    if ((name != null && seed.name !== name) || (path != null && seed.file_path !== path)) throw new Error('Symbol does not match the requested name/file_path');
    const project = requested ?? db.getProject(seed.project_id);
    if (!project || project.is_synthetic) throw new Error('A real owning project is required');
    const warnings: string[] = [];
    let seedBody = '', basis = 'structural';
    try {
      const path = projectRelativePath(project.root_path, seed.file_path);
      const file = await readProjectFile(project.root_path, path, signal, { offset: 0, limit: 1024 * 1024 + 4, encoding: 'utf8' });
      if (file.totalBytes > 1024 * 1024) warnings.push('Seed body exceeds 1 MiB; using structural context.');
      else {
        const parsed = await treeSitterSymbols(path, file.content, { signal });
        const definitions = parsed?.symbols.filter(s => s.name === seed.name) ?? [];
        // Ambiguous names use structural context; a stale line must not select
        // an unrelated same-named declaration after the source moves.
        const current = definitions.length === 1 ? definitions[0] : undefined;
        if (current?.line && current.end_line != null) {
          seedBody = file.content.split('\n').slice(current.line - 1, Math.min(current.end_line, current.line + 79)).join('\n').slice(0, 3000);
          basis = 'current_body_excerpt';
        } else warnings.push('Current seed declaration is unavailable or ambiguous; using structural context.');
      }
    } catch (error) { signal?.throwIfAborted(); warnings.push('Current seed body could not be read or parsed; using structural context.'); }
    const query = [`File: ${seed.file_path}`, `${seed.kind} ${seed.name}`, seed.signature ?? '', seed.comment ?? '', seedBody].filter(Boolean).join('\n').slice(0, 4096);
    signal?.throwIfAborted();
    const remote = await semanticSearchClient.searchProject(project.id, query, { mode: 'hybrid', type: 'symbols', limit: limit + 2,
      consumer: 'agent', sessionId: typeof args.__mcp_session_id === 'string' ? args.__mcp_session_id : undefined,
      companySessionId: typeof args.__mcp_company_session_id === 'string' ? args.__mcp_company_session_id : undefined, signal });
    signal?.throwIfAborted();
    const searched = remote.ok && remote.value ? remote.value : await hybridSearch.searchWithDiag(project.id, project.name, query,
      { mode: 'fts', type: 'symbols', limit: limit + 2, signal });
    signal?.throwIfAborted();
    const diag = searched.diagnostics;
    const degraded = !remote.ok || !diag.vectorAvailable || !diag.embeddingAvailable || !!diag.vectorError;
    const ranked = new Map<number, number>();
    for (const result of searched.results.slice(0, limit + 2)) {
      if (result.type !== 'symbol' || result.id === seed.id || !Number.isSafeInteger(result.id) || result.id < 1
        || !Number.isFinite(result.score) || ranked.has(result.id)) continue;
      ranked.set(result.id, result.score);
    }
    const retained = new Map(db.listAgentSemanticNeighbors(project.id, [...ranked.keys()]).map(s => [s.id, s]));
    const neighbors = [...ranked].flatMap(([id, score]) => {
      const symbol = retained.get(id); return symbol && symbol.project_id === project.id ? [{ ...symbol, score }] : [];
    }).slice(0, limit);
    if (degraded) warnings.push('Showing lexical fallback: ' + (remote.error ?? diag.vectorError ?? 'vector backend unavailable'));
    signal?.throwIfAborted();
    if (args.format === 'json') return JSON.stringify({ seed: { id: seed.id, name: seed.name, file_path: seed.file_path, line: seed.line },
      source: degraded ? 'lexical_fallback' : 'semantic', query_basis: basis, query_excerpt: true,
      requested_limit: limit, shown: neighbors.length, neighbors, warnings });
    return [`# Semantic neighbors of ${seed.kind} \`${seed.name}\` (${seed.file_path}:${seed.line ?? '?'})`,
      ...warnings.map(warning => '[note: ' + warning + ']'),
      ...neighbors.map(n => `${n.score.toFixed(3)} ${n.file_path}:${n.line ?? '?'} ${n.kind} ${n.name}`),
      ...(neighbors.length ? [] : ['No related symbols found. Use grep_code/find_references or refresh vector coverage.']),
    ].join('\n');
  },
});
