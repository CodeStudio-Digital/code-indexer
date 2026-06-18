/**
 * Migration 160 — Local History (estilo JetBrains): versões de arquivos do
 * projeto independentes do git.
 *
 * Duas tabelas, content-addressed (dedup por hash) porque o histórico ACUMULA
 * (N saves por arquivo); inline guardaria o arquivo inteiro N vezes.
 *   - `file_history_blobs`: pool de conteúdo (hash → content), refcounted,
 *     compartilhado entre revisões/arquivos/projetos.
 *   - `file_local_history`: 1 linha por versão capturada (pré-imagem de um save
 *     ou delete, ou rótulo manual).
 *
 * Aditivo/idempotente (`CREATE ... IF NOT EXISTS`) — risco zero a dados
 * existentes. Capturado por packages/api-handlers/src/files/local-history.ts.
 */
import type DatabaseConstructor from 'better-sqlite3';
import type { Migration } from './index.js';

type DB = InstanceType<typeof DatabaseConstructor>;

export const fileLocalHistory160: Migration = {
  version: 160,
  name: 'file_local_history',
  up: (db: DB): void => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS file_history_blobs (
        hash       TEXT PRIMARY KEY,
        content    TEXT NOT NULL,
        size       INTEGER NOT NULL,
        refcount   INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);

    db.exec(`
      CREATE TABLE IF NOT EXISTS file_local_history (
        id             INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id     INTEGER NOT NULL,
        path           TEXT NOT NULL,
        content_hash   TEXT,
        size           INTEGER NOT NULL DEFAULT 0,
        kind           TEXT NOT NULL,
        label          TEXT,
        existed_before INTEGER NOT NULL DEFAULT 1,
        oversized      INTEGER NOT NULL DEFAULT 0,
        created_at     TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);

    // Hot query: histórico de um arquivo, mais novo primeiro.
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_flh_file
        ON file_local_history(project_id, path, created_at DESC);
    `);
    // GC por idade / teardown de projeto.
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_flh_created
        ON file_local_history(project_id, created_at);
    `);
  },
};
