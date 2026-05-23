/**
 * Migration 102 — `doc_sources` ganha o tipo `'folder'` + colunas folder_*.
 *
 * Motivação (caso de uso real): o Unity Editor já instala TODA a doc
 * offline em `…\Editor\Data\Documentation\en\ScriptReference\`. Em vez
 * de bater em `docs.unity3d.com` com Chromium, contornar JS-rendered
 * nav, lidar com 429, etc. — apontar a indexação direto pra pasta
 * local resolve o problema com zero crawler. Esse novo tipo `'folder'`
 * é o terceiro irmão dos tipos `'pdf'` e `'url'` que já existem.
 *
 * Por que é uma migration mais pesada que as anteriores: SQLite NÃO
 * permite `ALTER TABLE … ADD CONSTRAINT CHECK` nem `… ALTER COLUMN`.
 * O CHECK existente é `type IN ('pdf','url')` — para aceitar `'folder'`
 * precisamos do "recreate table" recomendado pelos docs do SQLite:
 *
 *   1. PRAGMA defer_foreign_keys = ON   (FK checks até COMMIT, evita
 *      precisar de "PRAGMA foreign_keys=OFF" fora da transação)
 *   2. CREATE TABLE doc_sources_new com CHECK expandido + colunas novas
 *   3. INSERT INTO doc_sources_new SELECT * FROM doc_sources  (preserva
 *      TODAS as rows existentes; as colunas folder_* ficam NULL pra rows
 *      antigas, que é o default semântico correto)
 *   4. DROP TABLE doc_sources  (dependentes — doc_chunks, doc_chunk_vectors
 *      — têm FK por NOME, então sobrevivem o rename)
 *   5. ALTER TABLE doc_sources_new RENAME TO doc_sources
 *   6. Recriar os índices que foram dropados junto com a tabela
 *
 * Defer-FKs ON evita o "FOREIGN KEY constraint failed" no DROP. No
 * COMMIT o `foreign_key_check` implícito do SQLite confirma que
 * doc_chunks.source_id continua resolvendo (mesmos IDs, mesma coluna
 * `id` na tabela renomeada). `defer_foreign_keys` é auto-reset no
 * COMMIT/ROLLBACK, então não afeta migrations subsequentes.
 *
 * Companion das migrations 089/092/099/101 que tinham adicionado
 * colunas `crawl_*` simples via ALTER ADD COLUMN — aqui essas colunas
 * são preservadas verbatim e a CREATE TABLE NEW as reaplica.
 *
 * Idempotência: PRAGMA table_info guard no topo — se o novo CHECK +
 * colunas já existem, é no-op.
 */
import type DatabaseConstructor from 'better-sqlite3';
import type { Migration } from './index.js';

type DB = InstanceType<typeof DatabaseConstructor>;

export const docSourcesFolder103: Migration = {
  version: 103,
  name: 'doc_sources_folder',
  up: (db: DB): void => {
    // Idempotência: se já tem `folder_root_path`, a recreate-table já
    // rolou (ou outra encarnação dessa migration). Sair limpo.
    const cols = db
      .prepare(`PRAGMA table_info(doc_sources)`)
      .all() as Array<{ name: string }>;
    if (cols.some((c) => c.name === 'folder_root_path')) return;

    // Defer FK checks até o COMMIT. Sem isso o DROP TABLE doc_sources
    // explode com "FOREIGN KEY constraint failed" porque doc_chunks +
    // doc_chunk_vectors têm FK pra cá. O reset é automático no COMMIT.
    db.exec(`PRAGMA defer_foreign_keys = ON`);

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

    // Preserva todas as rows. As folder_* ficam NULL/default — correto
    // semanticamente porque rows pdf/url não têm config de pasta.
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

    // Drop a tabela antiga (FKs deferidas — doc_chunks fica órfão por
    // ~10ms até o RENAME logo abaixo). Os índices vão junto.
    db.exec(`DROP TABLE doc_sources`);
    db.exec(`ALTER TABLE doc_sources_new RENAME TO doc_sources`);

    // Recria os índices que estavam na 086. Sem `IF NOT EXISTS`
    // porque a tabela é nova; queremos falha alta se nome bater.
    db.exec(`
      CREATE INDEX idx_doc_sources_collection
        ON doc_sources(collection_id, status);
      CREATE INDEX idx_doc_sources_status
        ON doc_sources(status, updated_at);
    `);

    // Ao COMMIT, SQLite roda foreign_key_check implícito:
    //   doc_chunks.source_id → doc_sources.id    (passa: mesmos IDs preservados)
    //   doc_chunk_vectors.chunk_id → doc_chunks.id (passa: doc_chunks intacto)
    // Se algo falha, a transação inteira aborta e a migration não é
    // registrada — re-tenta no próximo boot.
  },
};
