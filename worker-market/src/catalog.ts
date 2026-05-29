/** D1 catalog queries for the plugin Market. */

export interface MarketInfo {
  name: string;
  displayName?: string;
  description?: string;
  latestVersion: string;
  downloads: number;
  category?: string;
  author?: string;
  brandColor?: string;
}

interface PluginRow {
  name: string;
  display_name: string | null;
  description: string | null;
  latest_version: string;
  downloads: number;
  category: string | null;
  author: string | null;
  brand_color: string | null;
}

const SELECT_COLS =
  'name, display_name, description, latest_version, downloads, category, author, brand_color';

function toInfo(r: PluginRow): MarketInfo {
  return {
    name: r.name,
    displayName: r.display_name ?? undefined,
    description: r.description ?? undefined,
    latestVersion: r.latest_version,
    downloads: r.downloads,
    category: r.category ?? undefined,
    author: r.author ?? undefined,
    brandColor: r.brand_color ?? undefined,
  };
}

export async function searchPlugins(db: D1Database, q: string): Promise<MarketInfo[]> {
  const like = `%${q}%`;
  const { results } = await db
    .prepare(
      `SELECT ${SELECT_COLS} FROM plugins
       WHERE name LIKE ?1 OR display_name LIKE ?1 OR description LIKE ?1
       ORDER BY downloads DESC LIMIT 50`,
    )
    .bind(like)
    .all<PluginRow>();
  return results.map(toInfo);
}

export async function getPlugin(db: D1Database, name: string): Promise<MarketInfo | null> {
  const row = await db
    .prepare(`SELECT ${SELECT_COLS} FROM plugins WHERE name = ?`)
    .bind(name)
    .first<PluginRow>();
  return row ? toInfo(row) : null;
}

export async function getVersionRow(
  db: D1Database,
  name: string,
  version: string,
): Promise<{ r2_key: string; signature: string } | null> {
  return db
    .prepare('SELECT r2_key, signature FROM plugin_versions WHERE name = ? AND version = ?')
    .bind(name, version)
    .first<{ r2_key: string; signature: string }>();
}

export async function recordDownload(db: D1Database, name: string, version: string): Promise<void> {
  await db.batch([
    db.prepare('INSERT INTO downloads (name, version) VALUES (?, ?)').bind(name, version),
    db.prepare('UPDATE plugins SET downloads = downloads + 1 WHERE name = ?').bind(name),
  ]);
}

export interface PublishedVersion {
  name: string;
  version: string;
  r2Key: string;
  size: number;
  sha256: string;
  signature: string;
}

export async function upsertVersion(db: D1Database, v: PublishedVersion): Promise<void> {
  await db.batch([
    db
      .prepare(
        `INSERT INTO plugins (name, display_name, latest_version) VALUES (?1, ?1, ?2)
         ON CONFLICT(name) DO UPDATE SET latest_version = ?2, updated_at = datetime('now')`,
      )
      .bind(v.name, v.version),
    db
      .prepare(
        `INSERT INTO plugin_versions (name, version, r2_key, size, sha256, signature)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(name, version) DO UPDATE SET
           r2_key = excluded.r2_key, size = excluded.size,
           sha256 = excluded.sha256, signature = excluded.signature`,
      )
      .bind(v.name, v.version, v.r2Key, v.size, v.sha256, v.signature),
  ]);
}
