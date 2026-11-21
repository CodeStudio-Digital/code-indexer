import type { CodeIndexDB } from '@mcp/store/db.js';
import { ProviderStore } from '@mcp/store/provider-store.js';
import { hydrateModel, modelReasoning, type ProviderModelRaw } from '@mcp/store/provider/hydrators.js';
import { meetsRequirements, type CatalogRequirements } from './catalog-intent.js';
import { catalogTerms, matchCatalogProviders, searchCatalogProviders } from '@mcp/shared/providers/catalog-match.js';
import type { DiscoveredModel, ProviderName } from '@mcp/shared/types.js';

export type CatalogModel = DiscoveredModel & Partial<Pick<ReturnType<typeof modelReasoning>, 'can_reason' | 'supported_reasoning_levels'>> & {
  context_window?: number | null; input_modalities?: string[] | null; evidence?: string;
};
export interface ModelPage { models: CatalogModel[]; total: number; offset: number; next_offset?: number;
  search?: { mode: 'hybrid' | 'metadata'; index: 'ready' | 'warming' | 'unavailable' } }

export function readProviderPage(db: CodeIndexDB, query: string | undefined, offset: number, limit: number) {
  const rows = db.raw().prepare('SELECT p.id, p.name, p.kind, COUNT(m.model_id) AS model_count FROM provider_configs p '
    + 'LEFT JOIN provider_models m ON m.provider_id=p.id AND m.enabled=1 WHERE p.enabled=1 GROUP BY p.id ORDER BY p.name, p.id')
    .all() as Array<{ id: string; name: string; kind: string; model_count: number }>;
  const matches = query ? searchCatalogProviders(rows.map(p => ({ ...p, enabled: true })), query) : rows;
  const providers = matches.slice(offset, offset + limit).map(({ id, name, kind, model_count }) => ({ id, name, kind, model_count }));
  return { providers, offset, total: matches.length, next_offset: offset + providers.length < matches.length ? offset + providers.length : null };
}

/** Read the active profile's catalog directly, without credentials, hydration
 * of provider configuration JSON, or another SQLite connection. */
export function readModelPage(db: CodeIndexDB, provider: string | undefined, offset: number, limit: number, query?: string,
  requires?: CatalogRequirements, exactId = false): ModelPage {
  const raw = db.raw();
  return raw.transaction(() => {
    const filters = ['p.enabled=1', 'm.enabled=1'];
    const args: string[] = [];
    if (provider) {
      const found = matchCatalogProviders(new ProviderStore(raw).listProviderIdentities(), provider);
      if (!found.length) return { models: [], total: 0, offset };
      filters.push(`p.id IN (${found.map(() => '?').join(',')})`);
      args.push(...found.map(p => p.id));
    }
    if (query && exactId) {
      const parts = query.split('::');
      filters.push('m.model_id=? COLLATE NOCASE');
      args.push(parts[0]);
      if (parts.length > 1) { filters.push('m.mode=? COLLATE NOCASE'); args.push(parts.slice(1).join('::')); }
    } else if (query) {
      const terms = [...new Set(catalogTerms(query))];
      if (!terms.length) return { models: [], total: 0, offset };
      const searchable = "lower(m.model_id || ' ' || m.name || ' ' || coalesce(m.display_name,'') || ' ' || m.mode)";
      for (const term of terms) {
        if (/^\d+(?:\.\d+)*$/.test(term)) {
          filters.push(`(' ' || ${searchable} || ' ') GLOB ?`);
          args.push(`*[^0-9.]${term}[^0-9.]*`);
        } else {
          filters.push(`instr(${searchable}, ?) > 0`);
          args.push(term);
        }
      }
    }
    const where = 'FROM provider_models m JOIN provider_configs p ON p.id=m.provider_id WHERE ' + filters.join(' AND ');
    if (requires && Object.keys(requires).length) {
      const rows = raw.prepare('SELECT m.*, p.kind AS provider_kind, p.base_url AS provider_base_url ' + where +
        ' ORDER BY p.name, p.id, m.name, m.mode, m.model_id').all(...args) as ProviderModelRaw[];
      const matches = rows.map(row => hydrateModel(row)).filter(m => meetsRequirements(m, requires));
      const models = matches.slice(offset, offset + limit).map(m => ({ provider: m.provider_id as ProviderName,
        id: m.model_id + (m.mode ? '::' + m.mode : ''), name: m.name, cached_at: m.updated_at, capabilities: ['text'],
        can_reason: m.can_reason, supported_reasoning_levels: m.supported_reasoning_levels,
        context_window: m.context_window, input_modalities: m.input_modalities }));
      return { models, total: matches.length, offset, ...(offset + models.length < matches.length ? { next_offset: offset + models.length } : {}) };
    }
    const total = (raw.prepare('SELECT COUNT(*) AS n ' + where).get(...args) as { n: number }).n;
    const details = !!(provider || query);
    const reasoning = details ? ', m.model_id, p.kind AS provider_kind, p.base_url AS provider_base_url, m.can_reason, m.default_reasoning_level, m.supported_reasoning_levels ' : ' ';
    const rows = raw.prepare("SELECT m.model_id || CASE WHEN m.mode != '' THEN '::' || m.mode ELSE '' END AS id, p.id AS provider, m.name, m.updated_at AS cached_at" + reasoning
      + where + ' ORDER BY p.name, p.id, m.name, m.mode, m.model_id LIMIT ? OFFSET ?')
      .all(...args, limit, offset) as Array<Omit<DiscoveredModel, 'capabilities'> & Parameters<typeof modelReasoning>[0]>;
    const models = rows.map(row => {
      const model = { provider: row.provider as ProviderName, id: row.id, name: row.name, cached_at: row.cached_at, capabilities: ['text'] };
      if (!details) return model;
      const { can_reason, supported_reasoning_levels } = modelReasoning(row);
      return { ...model, can_reason, supported_reasoning_levels };
    });
    return { models,
      total, offset, ...(offset + models.length < total ? { next_offset: offset + models.length } : {}) };
  })();
}
