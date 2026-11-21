import type { CodeIndexDB } from '@mcp/store/db.js';
import type { DiscoveredModel, ProviderName } from '@mcp/shared/types.js';

export interface ModelPage { models: DiscoveredModel[]; total: number; offset: number; next_offset?: number }

/** Read the active profile's catalog directly, without credentials, hydration
 * of provider configuration JSON, or another SQLite connection. */
export function readModelPage(db: CodeIndexDB, provider: string | undefined, offset: number, limit: number): ModelPage {
  const raw = db.raw();
  return raw.transaction(() => {
    const where = 'FROM provider_models m JOIN provider_configs p ON p.id=m.provider_id '
      + 'WHERE p.enabled=1 AND m.enabled=1' + (provider ? ' AND (p.id=? OR p.kind=?)' : '');
    const args = provider ? [provider, provider] : [];
    const total = (raw.prepare('SELECT COUNT(*) AS n ' + where).get(...args) as { n: number }).n;
    const models = raw.prepare("SELECT m.model_id || CASE WHEN m.mode != '' THEN '::' || m.mode ELSE '' END AS id, p.id AS provider, m.name, m.updated_at AS cached_at "
      + where + ' ORDER BY p.name, p.id, m.name, m.mode, m.model_id LIMIT ? OFFSET ?')
      .all(...args, limit, offset) as Array<Omit<DiscoveredModel, 'capabilities'>>;
    return { models: models.map(m => ({ ...m, provider: m.provider as ProviderName, capabilities: ['text'] })),
      total, offset, ...(offset + models.length < total ? { next_offset: offset + models.length } : {}) };
  })();
}
