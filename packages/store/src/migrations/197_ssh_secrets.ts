/**
 * Migração 197 — segredos nomeados do cliente SSH, referenciáveis em snippets.
 *
 * Um snippet pode conter placeholders `${secret:NOME}` (token do git, senha do
 * sudo, API key). O renderer resolve/substitui ANTES de rodar o comando. Os
 * valores ficam aqui, cifrados pelo renderer com o chaveiro do SO (Electron
 * `safeStorage`) — o store só persiste o blob opaco `enc_value`, exatamente
 * como `enc_password` em `ssh_hosts` (migração 173). Device-bound: o ciphertext
 * é inútil em outra máquina.
 *
 * Índice único em (project_id, name) → `${secret:NOME}` resolve sem ambiguidade.
 * Project-scoped, como as demais tabelas SSH. Idempotente (IF NOT EXISTS).
 */
import type DatabaseConstructor from 'better-sqlite3';
import type { Migration } from './index.js';

type DB = InstanceType<typeof DatabaseConstructor>;

export const sshSecrets197: Migration = {
  version: 197,
  name: 'ssh_secrets',
  up: (db: DB): void => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS ssh_secrets (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id INTEGER NOT NULL,
        name TEXT NOT NULL,                   -- referenciado como ${'${secret:name}'}
        enc_value TEXT NOT NULL,              -- safeStorage ciphertext (base64), device-bound
        description TEXT,                     -- nota humana, NÃO-secreta
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_ssh_secrets_project_name
        ON ssh_secrets(project_id, name);
    `);
  },
};
