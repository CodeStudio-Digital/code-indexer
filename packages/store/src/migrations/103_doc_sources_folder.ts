/**
 * Migration 103 — `doc_sources` ganha o tipo `'folder'` + colunas folder_*.
 *
 * Motivação (caso de uso real): o Unity Editor já instala TODA a doc
 * offline em `…\Editor\Data\Documentation\en\ScriptReference\`. Em vez
 * de bater em `docs.unity3d.com` com Chromium, contornar JS-rendered
 * nav, lidar com 429, etc. — apontar a indexação direto pra pasta
 * local resolve o problema com zero crawler. Esse novo tipo `'folder'`
 * é o terceiro irmão dos tipos `'pdf'` e `'url'` que já existem.
 *
 * Por que é uma migration `outsideTransaction`: SQLite NÃO permite
 * `ALTER TABLE … ADD CONSTRAINT CHECK`. O CHECK existente é
 * `type IN ('pdf','url')` — para aceitar `'folder'` precisamos do
 * "recreate table" recomendado pelos docs do SQLite. E para fazer
 * recreate-table seguramente quando há FKs apontando para a tabela
 * (doc_chunks.source_id → doc_sources.id), precisamos de
 * `PRAGMA foreign_keys = OFF` **fora** de qualquer transação —
 * SQLite ignora silenciosamente o pragma dentro de tx e o DROP falha
 * com `SQLITE_LOCKED` ("database table is locked", não FK error).
 *
 * Sequência oficial dos docs do SQLite (12-step ALTER TABLE):
 *
 *   1. PRAGMA foreign_keys = OFF   (FORA de transação — essencial)
 *   2. BEGIN TRANSACTION
 *   3. CREATE TABLE doc_sources_new com CHECK expandido + colunas novas
 *   4. INSERT INTO doc_sources_new SELECT * FROM doc_sources  (preserva
 *      TODAS as rows existentes; as colunas folder_* ficam NULL pra
 *      rows antigas — default semântico correto)
 *   5. DROP TABLE doc_sources  (dependentes — doc_chunks etc. — têm FK
 *      por NOME e sobrevivem ao rename)
 *   6. ALTER TABLE doc_sources_new RENAME TO doc_sources
 *   7. Recriar índices dropados junto com a tabela original
 *   8. PRAGMA foreign_key_check  (deve retornar 0 rows — todos FKs
 *      continuam apontando pra IDs preservados)
 *   9. COMMIT
 *  10. PRAGMA foreign_keys = ON  (restaurar enforcement)
 *
 * Se qualquer passo falhar entre 2-9, fazemos ROLLBACK e re-ativamos
 * `foreign_keys`. O try/catch garante que o DB nunca fica num estado
 * com FK desabilitada permanentemente, mesmo em crash.
 *
 * Idempotência: PRAGMA table_info guard no topo — se `folder_root_path`
 * já existe, a recreate-table rolou e a migration é no-op.
 *
 * Companion das migrations 089/092/099/101 que adicionaram colunas
 * `crawl_*` simples via ALTER ADD COLUMN. Aqui essas colunas são
 * preservadas verbatim pelo SELECT * acima.
 */
import type DatabaseConstructor from 'better-sqlite3';
import type { Migration } from './types.js';

type DB = InstanceType<typeof DatabaseConstructor>;

export const docSourcesFolder103: Migration = {
  version: 103,
  name: 'doc_sources_folder',
  // CRÍTICO: essa migration gerencia sua própria transação porque
  // precisa togglar foreign_keys OFF antes de BEGIN — o que é
  // impossível dentro do `db.transaction()` wrapper do runner.
  outsideTransaction: true,
  up: (db: DB): void => {
    // Idempotência: se já tem `folder_root_path`, a recreate-table já
    // rolou. Sair limpo sem mexer em nada.
    const cols = db
      .prepare(`PRAGMA table_info(doc_sources)`)
      .all() as Array<{ name: string }>;
    if (cols.some((c) => c.name === 'folder_root_path')) return;

    // ─── Passo 1: desativar FK enforcement (fora de qualquer tx) ──
    // Precisa estar OFF antes do BEGIN. Setado dentro de tx é no-op
    // silencioso. Se um erro abortar a migration, o `finally` ao final
    // reativa pra não deixar o DB num estado degradado.
    db.pragma('foreign_keys = OFF');

    try {
      // ─── Passos 2-9 dentro de uma transação manual ──────────────
      // Usar `db.transaction()` aqui dá BEGIN/COMMIT automáticos +
      // rollback em throw. Idêntico ao que o runner faria, mas com
      // foreign_keys já OFF antes de entrar.
      const tx = db.transaction(() => {
        db.exec(`
          CREATE TABLE doc_sources_new (
            id                       INTEGER PRIMARY KEY AUTOINCREMENT,
            collection_id            INTEGER NOT NULL REFERENCES doc_collections(id) ON DELETE CASCADE,
            type                     TEXT NOT NULL CHECK(type IN ('pdf','url','folder')),
            uri                      TEXT NOT NULL,
            title                    TEXT,
            status                   TEXT NOT NULL DEFAULT 'queued'
                                       CHECK(status IN ('queued','fetching','indexing','done','error')),
            error_message            TEXT,
            content_hash             TEXT,
            chunk_count              INTEGER NOT NULL DEFAULT 0,
            page_count               INTEGER NOT NULL DEFAULT 0,
            pages_accepted           INTEGER NOT NULL DEFAULT 0,
            pages_rejected           INTEGER NOT NULL DEFAULT 0,
            last_indexed_at          TEXT,
            -- Crawl config (URL only). Preservadas exatamente como hoje.
            crawl_enabled            INTEGER NOT NULL DEFAULT 0,
            crawl_max_pages          INTEGER NOT NULL DEFAULT 1,
            crawl_max_depth          INTEGER NOT NULL DEFAULT 0,
            crawl_same_origin        INTEGER NOT NULL DEFAULT 1,
            crawl_include_pattern    TEXT,
            crawl_exclude_pattern    TEXT,
            crawl_required_path      TEXT,                                       -- 089
            crawl_llm_extract_links  INTEGER NOT NULL DEFAULT 0,                  -- 092
            crawl_force_browser      INTEGER NOT NULL DEFAULT 0,                  -- 099
            crawl_browser_seed_only  INTEGER NOT NULL DEFAULT 0,                  -- 101
            pdf_size_bytes           INTEGER,
            cost_usd                 REAL NOT NULL DEFAULT 0,
            created_at               TEXT NOT NULL DEFAULT (datetime('now')),
            updated_at               TEXT NOT NULL DEFAULT (datetime('now')),
            -- Folder config (folder only). NULL pra rows pdf/url antigas.
            folder_root_path             TEXT,
            folder_include_glob          TEXT,
            folder_exclude_glob          TEXT,
            folder_max_files             INTEGER,
            folder_bypass_relevance_gate INTEGER NOT NULL DEFAULT 1,
            UNIQUE(collection_id, uri)
          );
        `);

        // Preserva todas as rows. As folder_* ficam NULL/default —
        // correto semanticamente porque rows pdf/url não têm folder.
        db.exec(`
          INSERT INTO doc_sources_new (
            id, collection_id, type, uri, title, status, error_message,
            content_hash, chunk_count, page_count, pages_accepted, pages_rejected,
            last_indexed_at,
            crawl_enabled, crawl_max_pages, crawl_max_depth, crawl_same_origin,
            crawl_include_pattern, crawl_exclude_pattern,
            crawl_required_path, crawl_llm_extract_links,
            crawl_force_browser, crawl_browser_seed_only,
            pdf_size_bytes, cost_usd, created_at, updated_at
          )
          SELECT
            id, collection_id, type, uri, title, status, error_message,
            content_hash, chunk_count, page_count, pages_accepted, pages_rejected,
            last_indexed_at,
            crawl_enabled, crawl_max_pages, crawl_max_depth, crawl_same_origin,
            crawl_include_pattern, crawl_exclude_pattern,
            crawl_required_path, crawl_llm_extract_links,
            crawl_force_browser, crawl_browser_seed_only,
            pdf_size_bytes, cost_usd, created_at, updated_at
          FROM doc_sources;
        `);

        // Com FK OFF o DROP procede mesmo com refs em doc_chunks. As
        // FKs em doc_chunks.source_id são resolvidas por NOME — após o
        // RENAME logo abaixo voltam a apontar pra tabela correta.
        db.exec(`DROP TABLE doc_sources`);
        db.exec(`ALTER TABLE doc_sources_new RENAME TO doc_sources`);

        // Recria os índices dropados junto com a tabela original
        // (vinham da migration 086).
        db.exec(`
          CREATE INDEX idx_doc_sources_collection
            ON doc_sources(collection_id, status);
          CREATE INDEX idx_doc_sources_status
            ON doc_sources(status, updated_at);
        `);

        // Sanity check: garante que nenhuma FK ficou apontando pra ID
        // que não existe mais. Em condições normais retorna 0 rows
        // porque preservamos todos os IDs no SELECT acima. Se algo
        // saiu errado, lançamos pra disparar o ROLLBACK.
        const violations = db.prepare(`PRAGMA foreign_key_check`).all();
        if (violations.length > 0) {
          throw new Error(
            `foreign_key_check found ${violations.length} violation(s) after doc_sources recreate-table: ${JSON.stringify(violations.slice(0, 5))}`,
          );
        }
      });
      tx();
    } finally {
      // Restaura FK enforcement IMUTAVELMENTE — mesmo em crash. Sem
      // isso, um erro deixaria o DB com foreign_keys=OFF até o
      // próximo restart, escondendo bugs futuros até esfriar.
      db.pragma('foreign_keys = ON');
    }
  },
};
