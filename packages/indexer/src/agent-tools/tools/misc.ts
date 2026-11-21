import { defineTool, type IndexTool } from '../tool.js';
import { resolveProject } from '../utils.js';
import type { ProviderName } from '@mcp/shared/types.js';
import { readRequirements } from '../../indexer/providers/catalog-intent.js';

const get_costs = defineTool({
  name: 'get_costs',
  tier: 'admin',
  access: 'read',
  description:
    'Read the historical provider-cost ledger (USD and tokens). Local structural indexing, ONNX embeddings and local reranking have no provider charge and are not represented as indexer cost here. ' +
    'Scope to one project via project_name or omit it for the global total; pass since (ISO date) to bound the window.',
  inputSchema: {
    type: 'object',
    properties: { project_name: { type: 'string' }, since: { type: 'string' } },
  },
  handler: (args, { db, costTracker, signal }) => {
    signal?.throwIfAborted();
    let since: string | undefined;
    if (args.since != null) {
      const raw = args.since;
      if (typeof raw !== 'string' || !/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2}))?$/.test(raw)
        || !Number.isFinite(Date.parse(raw)) || new Date(raw.slice(0, 10)).toISOString().slice(0, 10) !== raw.slice(0, 10)) {
        throw new Error('since must be a valid ISO date or timestamp with timezone');
      }
      // SQLite's ledger uses UTC "YYYY-MM-DD HH:mm:ss". Comparing a raw ISO
      // timestamp containing T excluded the entire matching day lexically.
      since = new Date(raw).toISOString().replace('T', ' ').replace(/\.000Z$/, '').replace(/Z$/, '');
    }
    let result;
    if (args.project_name != null) {
      if (typeof args.project_name !== 'string' || !args.project_name.trim()) throw new Error('project_name must be a nonempty string');
      const project = resolveProject(db, args.project_name as string);
      result = costTracker.getProjectCosts(project.id, since);
    } else result = costTracker.getGlobalCosts(since);
    signal?.throwIfAborted();
    return JSON.stringify(result, null, 2);
  },
});

const list_models = defineTool({
  name: 'list_models',
  tier: 'admin',
  access: 'read',
  description:
    'Find enabled models and providers in the local profile. Search accounts with {view:"providers",query:"Codex"}; read page.providers. ' +
    'For a named model pass provider, query and match:"name". For a task describe it in query with match:"intent"; optionally require input modalities, context or reasoning effort. ' +
    'Use the requested provider as a filter. Read page.models for IDs, capabilities and evidence; pass page.next_offset as offset until null. A bare delegation lookup uses the requested target. Set view:"models" to browse explicitly. ' +
    'live=true requests bounded public catalog reads using environment credentials. Refresh OAuth or custom catalogs in provider settings.',
  inputSchema: {
    type: 'object',
    properties: { view: { type: 'string', enum: ['providers', 'models'] }, query: { type: 'string', description: 'Provider name, model name or a natural-language task.' },
      match: { type: 'string', enum: ['name', 'intent'], description: 'Auto-detect by default. Name searches preserve exact versions; intent searches rank task descriptions locally.' },
      requires: { type: 'object', additionalProperties: false, properties: {
        input_modalities: { type: 'array', items: { type: 'string' }, description: 'All required input types, e.g. ["image"].' },
        min_context: { type: 'integer', minimum: 1, description: 'Minimum context window in tokens.' }, effort: { type: 'string' } } },
      provider: { type: 'string', description: 'Configured ID, display name, kind or alias such as Codex.' }, live: { type: 'boolean' },
      offset: { type: 'integer', minimum: 0 }, limit: { type: 'integer', minimum: 1, maximum: 500 } },
  },
  handler: async (args, { modelDiscovery, signal }) => {
    signal?.throwIfAborted();
    if (args.provider != null && (typeof args.provider !== 'string' || !args.provider.trim() || args.provider.length > 256)) throw new Error('Invalid provider');
    if (args.query != null && (typeof args.query !== 'string' || !args.query.trim() || args.query.length > 256)) throw new Error('Invalid catalog search query');
    if (args.view != null && args.view !== 'providers' && args.view !== 'models') throw new Error('Invalid catalog view');
    if (args.live != null && typeof args.live !== 'boolean') throw new Error('live must be boolean');
    if (args.match != null && args.match !== 'name' && args.match !== 'intent') throw new Error('Invalid catalog match');
    const requires = args.requires == null ? undefined : readRequirements(args.requires);
    if ((args.live || args.view === 'providers') && (args.match === 'intent' || requires)) throw new Error('Intent and capability search use configured local models');
    if (args.match === 'intent' && !args.query && !requires) throw new Error('Provide a task or model requirements');
    const offset = (args.offset ?? 0) as number, limit = (args.limit ?? ((args.query || requires) && args.view !== 'providers' ? 5 : 100)) as number;
    const query = (args.query as string | undefined)?.trim(), provider = (args.provider as string | undefined)?.trim();
    if (args.view === 'providers') {
      if (args.live) throw new Error('Provider search reads the configured local accounts. Use the models view for live catalogs.');
      const data = modelDiscovery.providerPage(query ?? provider, offset, limit);
      return { text: JSON.stringify(data), structuredContent: { ...data } };
    }
    const warnings: Array<{ provider: string; reason: string }> = [];
    const page = await modelDiscovery.discoverPage(provider as ProviderName | undefined, args.live === true, offset, limit,
      { query, requires, match: args.match as 'name' | 'intent' | undefined, signal, persistCache: false, onFallback: (provider, reason) => warnings.push({ provider, reason }) });
    signal?.throwIfAborted();
    const models = page.models.map(({ provider, id, name, can_reason, supported_reasoning_levels, input_modalities, context_window, evidence }) => ({ provider, id, name,
      ...(input_modalities !== undefined ? { input_modalities, context_window } : {}), ...(evidence ? {evidence} : {}),
      ...(can_reason !== undefined ? { can_reason, supported_reasoning_levels } : {}) }));
    const lines = models.map(m => `[${m.provider}] ${m.id} — ${m.name}` +
      (m.supported_reasoning_levels?.length ? ' (effort: ' + m.supported_reasoning_levels.join(', ') + ')' : '') +
      (m.evidence ? ' — ' + m.evidence : '')).join('\n');
    const meta = { total: page.total, offset: page.offset, next_offset: page.next_offset,
      ...(page.search ? { search: page.search } : {}),
      ...(page.next_offset != null ? { recovery: { tool: 'list_models', args: { ...args, offset: page.next_offset } } } : {}), warnings };
    return { text: lines + '\n' + JSON.stringify(meta),
      structuredContent: { models, total: page.total, offset: page.offset, next_offset: page.next_offset ?? null, warnings,
        ...(page.search ? { search: page.search } : {}),
        ...(query ? { filters: { ...(provider ? { provider } : {}), query } } : {}) },
      ...(page.total > page.models.length ? { sourceTruncations: [{ technique: 'model-catalog-page', inputSize: page.total,
        outputSize: page.models.length, unit: 'items' as const, recoverable: true }] } : {}) };
  },
});

export const miscTools: IndexTool[] = [get_costs, list_models];
