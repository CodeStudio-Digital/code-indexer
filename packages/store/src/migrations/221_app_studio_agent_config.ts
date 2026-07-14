import type DatabaseConstructor from 'better-sqlite3';
import type { Migration } from './index.js';

type DB = InstanceType<typeof DatabaseConstructor>;

function tableExists(db: DB, table: string): boolean {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table);
}

export const appStudioAgentConfig221: Migration = {
  version: 221,
  name: 'app_studio_agent_config',
  up(db: DB): void {
    if (!tableExists(db, 'app_studio_sessions')) return;
    const columns = db.prepare('PRAGMA table_info(app_studio_sessions)').all() as Array<{ name: string }>;
    if (!columns.some((column) => column.name === 'agent_config_json')) {
      db.exec('ALTER TABLE app_studio_sessions ADD COLUMN agent_config_json TEXT');
    }
  },
};
