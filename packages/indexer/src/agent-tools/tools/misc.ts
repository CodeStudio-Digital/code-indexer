import { defineTool, type IndexTool } from '../tool.js';
import { resolveProject } from '../utils.js';
import type { ProviderName } from '@mcp/shared/types.js';

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
    'List one page of LLM models from this profile. Default listing is local, with no network or cache writes.\n' +
    'Filter with provider; live=true requests bounded public catalog reads using environment credentials. OAuth/custom providers use their local catalog; refresh them in provider settings. Follow next_offset for more models.',
  inputSchema: {
    type: 'object',
    properties: { provider: { type: 'string' }, live: { type: 'boolean' },
      offset: { type: 'integer', minimum: 0 }, limit: { type: 'integer', minimum: 1, maximum: 500 } },
  },
  handler: async (args, { modelDiscovery, signal }) => {
    signal?.throwIfAborted();
    if (args.provider != null && (typeof args.provider !== 'string' || !args.provider.trim() || args.provider.length > 256)) throw new Error('Invalid provider');
    if (args.live != null && typeof args.live !== 'boolean') throw new Error('live must be boolean');
    const warnings: Array<{ provider: string; reason: string }> = [];
    const page = await modelDiscovery.discoverPage(args.provider as ProviderName | undefined, args.live === true,
      (args.offset ?? 0) as number, (args.limit ?? 100) as number,
      { signal, persistCache: false, onFallback: (provider, reason) => warnings.push({ provider, reason }) });
    signal?.throwIfAborted();
    const lines = page.models.map(m => `[${m.provider}] ${m.id} — ${m.name}`).join('\n');
    const meta = { total: page.total, offset: page.offset, next_offset: page.next_offset,
      ...(page.total > page.models.length ? { recovery: { tool: 'list_models', args: { ...args, offset: page.next_offset ?? 0 } } } : {}), warnings };
    return { text: lines + '\n' + JSON.stringify(meta),
      ...(page.total > page.models.length ? { sourceTruncations: [{ technique: 'model-catalog-page', inputSize: page.total,
        outputSize: page.models.length, unit: 'items' as const, recoverable: true }] } : {}) };
  },
});

export const miscTools: IndexTool[] = [get_costs, list_models];
