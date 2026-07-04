/**
 * Migração 198 — flag `is_shared` em hosts SSH (compartilhar host entre projetos).
 *
 * Um host com `is_shared=1` aparece em TODOS os projetos: fica no DB central e é
 * lido via `SshStore.listSharedHosts()` (project-scoped `listHosts` passa a
 * excluir os compartilhados). `project_id` continua como o projeto de origem.
 * Aditiva e idempotente (guarda contra a coluna já existir). Ver mig 173.
 */
import type DatabaseConstructor from 'better-sqlite3';
import type { Migration } from './index.js';

type DB = InstanceType<typeof DatabaseConstructor>;

export const sshHostShared198: Migration = {
  version: 198,
  name: 'ssh_host_shared',
  up: (db: DB): void => {
    const cols = db.prepare('PRAGMA table_info(ssh_hosts)').all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === 'is_shared')) {
      db.exec('ALTER TABLE ssh_hosts ADD COLUMN is_shared INTEGER NOT NULL DEFAULT 0');
    }
    db.exec('CREATE INDEX IF NOT EXISTS idx_ssh_hosts_shared ON ssh_hosts(is_shared)');
  },
};
