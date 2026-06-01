import type { Project } from '@mcp/shared/types.js';
import type { DB } from './types.js';

type ProjectUpdates = Partial<Pick<Project,
  'name' | 'description' | 'group_name' | 'root_path' | 'provider' | 'model' |
  'last_indexed' | 'file_count' | 'symbol_count' | 'embeddings_enabled' | 'search_mode' |
  'node_version'
>>;

export function create(db: DB, name: string, rootPath: string, description?: string): Project {
  const stmt = db.prepare(`
    INSERT INTO projects (name, root_path, description)
    VALUES (?, ?, ?)
  `);
  const result = stmt.run(name, rootPath, description ?? null);
  return get(db, result.lastInsertRowid as number)!;
}

export function get(db: DB, id: number): Project | undefined {
  return db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as Project | undefined;
}

export function getByName(db: DB, name: string): Project | undefined {
  return db.prepare('SELECT * FROM projects WHERE name = ?').get(name) as Project | undefined;
}

export function getByPath(db: DB, rootPath: string): Project | undefined {
  const exact = db.prepare('SELECT * FROM projects WHERE root_path = ?').get(rootPath) as Project | undefined;
  if (exact) return exact;
  return db.prepare("SELECT * FROM projects WHERE root_path LIKE '%' || ?").get(rootPath) as Project | undefined;
}

export function list(db: DB): Project[] {
  return db.prepare('SELECT * FROM projects ORDER BY name').all() as Project[];
}

export function update(db: DB, id: number, updates: ProjectUpdates): void {
  const fields: string[] = [];
  const values: unknown[] = [];

  for (const [key, value] of Object.entries(updates)) {
    fields.push(`${key} = ?`);
    values.push(value);
  }

  if (fields.length === 0) return;

  fields.push("updated_at = datetime('now')");
  values.push(id);

  db.prepare(`UPDATE projects SET ${fields.join(', ')} WHERE id = ?`).run(...values);
}

export function del(db: DB, id: number): void {
  db.prepare('DELETE FROM projects WHERE id = ?').run(id);
}

export function resolve(db: DB, name?: string, rootPath?: string): Project {
  if (name) {
    const p = getByName(db, name);
    if (p) return p;
  }
  if (rootPath) {
    const p = getByPath(db, rootPath);
    if (p) return p;
  }

  const cwd = rootPath ?? process.cwd();
  const existing = getByPath(db, cwd);
  if (existing) return existing;

  const parts = cwd.replace(/\\/g, '/').split('/').filter(Boolean);
  const autoName = parts.slice(-2).join('/');
  return create(db, name ?? autoName, cwd);
}
