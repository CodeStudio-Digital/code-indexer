/**
 * Migration 132 — Design System Studio sessions.
 *
 * O modo Design System deixa de ser um pipeline autônomo em company mode
 * (master + subordinados sobre um zip) e passa a ser o **DS Studio**: uma
 * sessão single de chat sobre um projeto-workspace real no host (galeria
 * Vite + pacote npm), com preview ao vivo e publish guiado.
 *
 * Mudanças em `design_system_sessions`:
 *   - `company_session_id` vira NULLABLE — sessões studio não têm company
 *     session por trás. Linhas legacy preservam o valor.
 *   - `+ project_id` — FK para `projects(id)`; o vínculo durável do studio
 *     é o projeto-workspace (sessões de chat são N:1 com projeto e
 *     recriáveis, por isso NÃO guardamos coder_session_id).
 *   - `+ kind` — 'company' (legacy, read-only daqui em diante) ou 'studio'.
 *   - CHECK de coerência: company ⇒ tem company_session_id; studio ⇒ tem
 *     project_id.
 *   - UNIQUE parcial em project_id (1 DS por projeto-workspace).
 *
 * Colunas vestigiais (mantidas por causa das versões legacy, documentadas
 * aqui): `design_system_versions.storybook_path` (Storybook foi aposentado
 * — a galeria viva do workspace substitui) e `source_zip_*` nesta tabela
 * (studio usa import/ dentro do workspace; zip ainda alimenta o caminho de
 * re-extract legacy).
 *
 * Por que recreate-table (12-step): SQLite não permite remover NOT NULL
 * nem adicionar CHECK via ALTER. Pattern idêntico ao da migration 103 —
 * `PRAGMA foreign_keys = OFF` precisa acontecer FORA de transação (dentro
 * é no-op silencioso e o DROP falha com SQLITE_LOCKED), por isso
 * `outsideTransaction: true` e transação manual com foreign_key_check
 * antes do COMMIT.
 */
import type DatabaseConstructor from 'better-sqlite3';
import type { Migration } from './index.js';

type DB = InstanceType<typeof DatabaseConstructor>;

export const designSystemStudio132: Migration = {
  version: 132,
  name: 'design_system_studio',
  // Gerencia a própria transação: foreign_keys OFF deve preceder o BEGIN.
  outsideTransaction: true,
  up: (db: DB): void => {
    // Idempotência: se `project_id` já existe, a recreate-table já rolou.
    const cols = db
      .prepare(`PRAGMA table_info(design_system_sessions)`)
      .all() as Array<{ name: string }>;
    if (cols.some((c) => c.name === 'project_id')) return;

    db.pragma('foreign_keys = OFF');
    try {
      const tx = db.transaction(() => {
        db.exec(`
          CREATE TABLE design_system_sessions_new (
            id                   INTEGER PRIMARY KEY AUTOINCREMENT,
            company_session_id   INTEGER
                                 REFERENCES company_sessions(id) ON DELETE CASCADE,
            project_id           INTEGER
                                 REFERENCES projects(id) ON DELETE CASCADE,
            kind                 TEXT NOT NULL DEFAULT 'company'
                                 CHECK(kind IN ('company','studio')),
            name                 TEXT NOT NULL,
            package_name         TEXT NOT NULL,
            stack                TEXT NOT NULL
                                 CHECK(stack IN ('react-ts','vue-ts','angular')),
            source_zip_hash      TEXT,
            source_zip_path      TEXT,
            next_bump_hint       TEXT NOT NULL DEFAULT 'patch'
                                 CHECK(next_bump_hint IN ('patch','minor','major')),
            mcp_server_config_id TEXT
                                 REFERENCES mcp_server_configs(id) ON DELETE SET NULL,
            created_at           TEXT NOT NULL DEFAULT (datetime('now')),
            CHECK (
              (kind = 'company' AND company_session_id IS NOT NULL)
              OR (kind = 'studio' AND project_id IS NOT NULL)
            )
          );
        `);

        // Preserva todas as rows legacy: kind='company' (default da coluna),
        // project_id NULL — coerente com o CHECK acima.
        db.exec(`
          INSERT INTO design_system_sessions_new (
            id, company_session_id, name, package_name, stack,
            source_zip_hash, source_zip_path, next_bump_hint,
            mcp_server_config_id, created_at
          )
          SELECT
            id, company_session_id, name, package_name, stack,
            source_zip_hash, source_zip_path, next_bump_hint,
            mcp_server_config_id, created_at
          FROM design_system_sessions;
        `);

        // FKs filhas (design_system_versions.ds_session_id) referenciam por
        // NOME de tabela — com foreign_keys OFF o DROP procede e o RENAME
        // religa a referência.
        db.exec(`DROP TABLE design_system_sessions`);
        db.exec(`ALTER TABLE design_system_sessions_new RENAME TO design_system_sessions`);

        // Recria o índice original (048) + os novos do studio.
        db.exec(`
          CREATE INDEX idx_ds_sessions_company
            ON design_system_sessions(company_session_id)
            WHERE company_session_id IS NOT NULL;
          CREATE UNIQUE INDEX idx_ds_sessions_project
            ON design_system_sessions(project_id)
            WHERE project_id IS NOT NULL;
        `);

        const violations = db.prepare(`PRAGMA foreign_key_check`).all();
        if (violations.length > 0) {
          throw new Error(
            `foreign_key_check found ${violations.length} violation(s) after design_system_sessions recreate-table: ${JSON.stringify(violations.slice(0, 5))}`,
          );
        }
      });
      tx();
    } finally {
      // Mesmo em crash o DB não pode ficar com FK enforcement desligado.
      db.pragma('foreign_keys = ON');
    }
  },
};
