/**
 * Cobertura da migration 103 — recreate-table de `doc_sources` para
 * ampliar o CHECK do `type` e adicionar colunas folder_*.
 *
 * Pin de invariantes:
 *   - PRAGMA foreign_keys = OFF é setado ANTES de BEGIN, ON é
 *     restaurado mesmo em crash.
 *   - INSERT SELECT preserva TODAS as rows existentes (ids, valores
 *     idênticos).
 *   - CHECK do `type` agora aceita 'folder' (além de 'pdf'/'url').
 *   - FKs em doc_chunks.source_id continuam resolvendo após o RENAME.
 *   - Re-aplicar a migration é no-op (PRAGMA table_info guard).
 *
 * Usa Database em-memória (`:memory:`) — recreate-table é uma operação
 * cara em disco, em memória é instantâneo. Como better-sqlite3 não
 * compartilha conexões entre processos, a in-memory DB é totalmente
 * isolada por teste.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import type DatabaseConstructor from 'better-sqlite3';
import { docSourcesFolder103 } from '../103_doc_sources_folder.js';

type DB = InstanceType<typeof DatabaseConstructor>;
let db: DB;

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  // Emula o schema relevante do 086 + as colunas adicionadas pelas
  // migrations 089/092/099/101. Sem rodar todas as migrations
  // anteriores — testamos só a 103 isoladamente.
  db.exec(`
    CREATE TABLE doc_collections (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      name            TEXT NOT NULL UNIQUE,
      created_at      TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE doc_sources (
      id                       INTEGER PRIMARY KEY AUTOINCREMENT,
      collection_id            INTEGER NOT NULL REFERENCES doc_collections(id) ON DELETE CASCADE,
      type                     TEXT NOT NULL CHECK(type IN ('pdf','url')),
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
      crawl_enabled            INTEGER NOT NULL DEFAULT 0,
      crawl_max_pages          INTEGER NOT NULL DEFAULT 1,
      crawl_max_depth          INTEGER NOT NULL DEFAULT 0,
      crawl_same_origin        INTEGER NOT NULL DEFAULT 1,
      crawl_include_pattern    TEXT,
      crawl_exclude_pattern    TEXT,
      crawl_required_path      TEXT,
      crawl_llm_extract_links  INTEGER NOT NULL DEFAULT 0,
      crawl_force_browser      INTEGER NOT NULL DEFAULT 0,
      crawl_browser_seed_only  INTEGER NOT NULL DEFAULT 0,
      pdf_size_bytes           INTEGER,
      cost_usd                 REAL NOT NULL DEFAULT 0,
      created_at               TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at               TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(collection_id, uri)
    );

    CREATE INDEX idx_doc_sources_collection
      ON doc_sources(collection_id, status);
    CREATE INDEX idx_doc_sources_status
      ON doc_sources(status, updated_at);

    CREATE TABLE doc_chunks (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      source_id    INTEGER NOT NULL REFERENCES doc_sources(id) ON DELETE CASCADE,
      content      TEXT NOT NULL,
      created_at   TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
});

afterEach(() => {
  db.close();
});

describe('migration 103 — doc_sources_folder', () => {
  it('declares outsideTransaction: true', () => {
    // Pin: o runner usa essa propriedade pra pular o auto-wrap em
    // db.transaction(). Esquecer disso faz a migration explodir com
    // SQLITE_LOCKED como o usuário viu na primeira tentativa.
    expect(docSourcesFolder103.outsideTransaction).toBe(true);
  });

  it('adds folder_* columns + expands CHECK to accept "folder"', () => {
    docSourcesFolder103.up(db);

    const cols = db
      .prepare(`PRAGMA table_info(doc_sources)`)
      .all() as Array<{ name: string }>;
    const names = new Set(cols.map((c) => c.name));
    expect(names.has('folder_root_path')).toBe(true);
    expect(names.has('folder_include_glob')).toBe(true);
    expect(names.has('folder_exclude_glob')).toBe(true);
    expect(names.has('folder_max_files')).toBe(true);
    expect(names.has('folder_bypass_relevance_gate')).toBe(true);

    // Confirma que o CHECK agora aceita 'folder' tentando inserir uma.
    db.prepare(
      `INSERT INTO doc_collections (name) VALUES ('test')`,
    ).run();
    expect(() => {
      db.prepare(
        `INSERT INTO doc_sources (collection_id, type, uri, folder_root_path)
         VALUES (1, 'folder', 'folder:///tmp/test', '/tmp/test')`,
      ).run();
    }).not.toThrow();
  });

  it('preserves all existing rows verbatim through recreate-table', () => {
    db.prepare(`INSERT INTO doc_collections (name) VALUES ('mycol')`).run();
    db.prepare(
      `INSERT INTO doc_sources (
         collection_id, type, uri, title,
         crawl_enabled, crawl_max_pages, crawl_force_browser, pdf_size_bytes
       ) VALUES (1, 'url', 'https://example.com/docs', 'Example Docs',
                 1, 50, 1, NULL)`,
    ).run();
    db.prepare(
      `INSERT INTO doc_sources (
         collection_id, type, uri, title, pdf_size_bytes
       ) VALUES (1, 'pdf', 'pdf://manual.pdf', 'Manual', 1024000)`,
    ).run();

    const before = db
      .prepare('SELECT id, type, uri, title, pdf_size_bytes, crawl_max_pages, crawl_force_browser FROM doc_sources ORDER BY id')
      .all();

    docSourcesFolder103.up(db);

    const after = db
      .prepare('SELECT id, type, uri, title, pdf_size_bytes, crawl_max_pages, crawl_force_browser FROM doc_sources ORDER BY id')
      .all();

    expect(after).toEqual(before);
  });

  it('preserves doc_chunks FK references (source_id continues to resolve)', () => {
    db.prepare(`INSERT INTO doc_collections (name) VALUES ('c1')`).run();
    db.prepare(
      `INSERT INTO doc_sources (collection_id, type, uri) VALUES (1, 'url', 'https://a.example')`,
    ).run();
    db.prepare(
      `INSERT INTO doc_chunks (source_id, content) VALUES (1, 'chunk content')`,
    ).run();

    docSourcesFolder103.up(db);

    // Os chunks continuam existindo e o JOIN segue funcionando.
    const joined = db
      .prepare(
        `SELECT c.id AS chunk_id, s.uri
           FROM doc_chunks c JOIN doc_sources s ON s.id = c.source_id`,
      )
      .all() as Array<{ chunk_id: number; uri: string }>;
    expect(joined).toHaveLength(1);
    expect(joined[0]!.uri).toBe('https://a.example');

    // FK enforcement: tentar inserir chunk com source_id inexistente
    // deve falhar (= ON foi restaurado corretamente).
    expect(() => {
      db.prepare(`INSERT INTO doc_chunks (source_id, content) VALUES (99999, 'x')`).run();
    }).toThrow(/FOREIGN KEY constraint failed/);
  });

  it('is idempotent — re-running the migration is a no-op', () => {
    docSourcesFolder103.up(db);

    // Segunda chamada não deve recriar a tabela (e portanto não vai
    // perder rows ou índices).
    db.prepare(`INSERT INTO doc_collections (name) VALUES ('c1')`).run();
    db.prepare(
      `INSERT INTO doc_sources (collection_id, type, uri, folder_root_path)
       VALUES (1, 'folder', 'folder:///tmp/x', '/tmp/x')`,
    ).run();

    docSourcesFolder103.up(db);
    // A row inserida acima continua lá.
    const rows = db.prepare(`SELECT COUNT(*) AS c FROM doc_sources`).get() as { c: number };
    expect(rows.c).toBe(1);
  });

  it('restores PRAGMA foreign_keys=ON after running (no permanent leak)', () => {
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
    docSourcesFolder103.up(db);
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
  });

  it('restores PRAGMA foreign_keys=ON even when the migration crashes mid-run', () => {
    // Fabrica uma violação de FK: cria um chunk órfão (source_id=99
    // que não existe) — depois roda a migration. O PRAGMA foreign_key_check
    // ao final da tx vai disparar e a tx é rolled back. O FINALLY tem
    // que reativar foreign_keys mesmo assim.
    db.pragma('foreign_keys = OFF');
    db.prepare(`INSERT INTO doc_chunks (source_id, content) VALUES (99, 'orphan')`).run();
    db.pragma('foreign_keys = ON');

    expect(() => docSourcesFolder103.up(db)).toThrow(/foreign_key_check found/);
    // Mesmo após crash, foreign_keys voltou pra ON.
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
  });
});
