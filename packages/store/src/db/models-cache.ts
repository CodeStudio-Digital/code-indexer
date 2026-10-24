import type { DiscoveredModel } from '@mcp/shared/types.js';
import type { DB } from './types.js';

const FRESH_MS = 24 * 60 * 60 * 1000;

export function get(db: DB, provider: string): DiscoveredModel[] | null {
  const row = db.prepare('SELECT models, fetched_at FROM models_cache WHERE provider = ? AND length(CAST(models AS BLOB)) <= 4194304')
    .get(provider) as { models: string; fetched_at: string } | undefined;
  if (!row) return null;

  const fetchedAt = new Date(row.fetched_at + 'Z').getTime();
  const now = Date.now();
  if (!Number.isFinite(fetchedAt) || now - fetchedAt > FRESH_MS) return null;
  try {
    const models: unknown = JSON.parse(row.models);
    if (!Array.isArray(models) || models.length > 10_000 || !models.every(m => m && typeof m.id === 'string'
      && typeof m.provider === 'string' && typeof m.name === 'string' && Array.isArray(m.capabilities)
      && m.id.length <= 1024 && m.name.length <= 4096)) return null;
    return models as DiscoveredModel[];
  } catch { return null; }
}

export function set(db: DB, provider: string, models: DiscoveredModel[]): void {
  db.prepare(`
    INSERT INTO models_cache (provider, models, fetched_at)
    VALUES (?, ?, datetime('now'))
    ON CONFLICT(provider) DO UPDATE SET models = excluded.models, fetched_at = excluded.fetched_at
  `).run(provider, JSON.stringify(models));
}
