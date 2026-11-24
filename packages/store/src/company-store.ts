/**
 * Minimal shared Company catalog.
 *
 * SQLite is allowed here only for reusable Company templates. Operational
 * Company/App Studio state is owned by filesystem session bundles.
 */
import { createRequire } from 'node:module';
import type DatabaseConstructor from 'better-sqlite3';
import type { CompanyRoleConfig, CompanyTemplate } from '@mcp/company/types.js';
import * as templatesDomain from './company/templates.js';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3') as typeof DatabaseConstructor;
type DB = InstanceType<typeof Database>;

export class CompanyStore {
  private readonly db: DB;
  private readonly ownsHandle: boolean;

  constructor(dbPathOrHandle: string | DB) {
    if (typeof dbPathOrHandle === 'string') {
      this.db = new Database(dbPathOrHandle);
      this.db.pragma('journal_mode = WAL');
      this.db.pragma('foreign_keys = ON');
      this.ownsHandle = true;
    } else {
      this.db = dbPathOrHandle;
      this.ownsHandle = false;
    }
  }

  close(): void {
    if (this.ownsHandle) this.db.close();
  }

  // ─── Reusable Company templates (essential SQLite catalog) ─────
  createTemplate(
    name: string,
    description: string,
    roles: CompanyRoleConfig[],
  ): CompanyTemplate {
    return templatesDomain.createTemplate(this.db, name, description, roles);
  }

  /** Persist the reusable template and its retry receipt in the same SQLite transaction. */
  createTemplateForDraft(draftId:string,name:string,description:string,roles:CompanyRoleConfig[]):CompanyTemplate {
    return this.db.transaction(() => {
      const key = 'company.template.draft.' + draftId;
      const saved = this.db.prepare('SELECT value FROM app_settings WHERE key=?').get(key) as {value:string}|undefined;
      if (saved) {
        const template=this.getTemplate(Number(saved.value));
        if (!template) throw new Error('O template criado por este rascunho foi excluído.');
        return template;
      }
      const template=this.createTemplate(name,description,roles);
      this.db.prepare('INSERT INTO app_settings (key,value,updated_at) VALUES (?,?,?)').run(key,String(template.id),new Date().toISOString());
      return template;
    }).immediate();
  }

  getTemplate(id: number): CompanyTemplate | null {
    return templatesDomain.getTemplate(this.db, id);
  }

  listTemplates(): CompanyTemplate[] {
    return templatesDomain.listTemplates(this.db);
  }

  updateTemplate(
    id: number,
    patch: {
      name?: string;
      description?: string;
      roles?: CompanyRoleConfig[];
    },
  ): CompanyTemplate | null {
    return templatesDomain.updateTemplate(this.db, id, patch);
  }

  deleteTemplate(id: number): boolean {
    return templatesDomain.deleteTemplate(this.db, id);
  }

}
