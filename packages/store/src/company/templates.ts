/**
 * `company_templates` CRUD — pure functions over a `better-sqlite3`
 * Database handle. Extracted from `CompanyStore` so the methods can
 * grow without bloating the 1750-LOC monolith and so future tests can
 * exercise template operations with an in-memory DB alone.
 */
import type { Database as DB } from 'better-sqlite3';
import type {
  CompanyRoleConfig,
  CompanyTemplate,
} from '@mcp/company/types.js';

interface TemplateRow {
  id: number;
  name: string;
  description: string;
  roles_json: string;
  created_at: string;
  updated_at: string;
}

function mapTemplateRow(row: TemplateRow): CompanyTemplate {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    roles: JSON.parse(row.roles_json),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function createTemplate(
  db: DB,
  name: string,
  description: string,
  roles: CompanyRoleConfig[],
): CompanyTemplate {
  const stmt = db.prepare(`
    INSERT INTO company_templates (name, description, roles_json)
    VALUES (?, ?, ?)
  `);
  const r = stmt.run(name, description, JSON.stringify(roles));
  return getTemplate(db, Number(r.lastInsertRowid))!;
}

export function getTemplate(db: DB, id: number): CompanyTemplate | null {
  const row = db
    .prepare('SELECT * FROM company_templates WHERE id = ?')
    .get(id) as TemplateRow | undefined;
  return row ? mapTemplateRow(row) : null;
}

export function listTemplates(db: DB): CompanyTemplate[] {
  const rows = db
    .prepare('SELECT * FROM company_templates ORDER BY updated_at DESC')
    .all() as TemplateRow[];
  return rows.map(mapTemplateRow);
}

export function updateTemplate(
  db: DB,
  id: number,
  patch: { name?: string; description?: string; roles?: CompanyRoleConfig[] },
): CompanyTemplate | null {
  const sets: string[] = [];
  const params: unknown[] = [];
  if (patch.name !== undefined) {
    sets.push('name = ?');
    params.push(patch.name);
  }
  if (patch.description !== undefined) {
    sets.push('description = ?');
    params.push(patch.description);
  }
  if (patch.roles !== undefined) {
    sets.push('roles_json = ?');
    params.push(JSON.stringify(patch.roles));
  }
  if (sets.length === 0) return getTemplate(db, id);
  sets.push("updated_at = datetime('now')");
  params.push(id);
  db.prepare(`UPDATE company_templates SET ${sets.join(', ')} WHERE id = ?`).run(
    ...params,
  );
  return getTemplate(db, id);
}

export function deleteTemplate(db: DB, id: number): boolean {
  const r = db.prepare('DELETE FROM company_templates WHERE id = ?').run(id);
  return r.changes > 0;
}
