import type { DB } from '../types.js';

export function createFtsTables(db: DB): void {
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS files_fts USING fts5(
      path, summary, concepts, content='files', content_rowid='id',
      tokenize='unicode61 remove_diacritics 2'
    );

    CREATE VIRTUAL TABLE IF NOT EXISTS symbols_fts USING fts5(
      name, kind, signature, comment, tags, file_path, parent,
      content='symbols', content_rowid='id',
      tokenize='unicode61 remove_diacritics 2'
    );
  `);

  db.exec(`
    CREATE TRIGGER IF NOT EXISTS files_ai AFTER INSERT ON files BEGIN
      INSERT INTO files_fts(rowid, path, summary, concepts)
      VALUES (new.id, new.path, new.summary, new.concepts);
    END;

    CREATE TRIGGER IF NOT EXISTS files_ad AFTER DELETE ON files BEGIN
      INSERT INTO files_fts(files_fts, rowid, path, summary, concepts)
      VALUES ('delete', old.id, old.path, old.summary, old.concepts);
    END;

    CREATE TRIGGER IF NOT EXISTS symbols_ai AFTER INSERT ON symbols BEGIN
      INSERT INTO symbols_fts(rowid, name, kind, signature, comment, tags, file_path, parent)
      VALUES (new.id, new.name, new.kind, new.signature, COALESCE(new.comment,''), new.tags, new.file_path, COALESCE(new.parent,''));
    END;

    CREATE TRIGGER IF NOT EXISTS symbols_ad AFTER DELETE ON symbols BEGIN
      INSERT INTO symbols_fts(symbols_fts, rowid, name, kind, signature, comment, tags, file_path, parent)
      VALUES ('delete', old.id, old.name, old.kind, old.signature, COALESCE(old.comment,''), old.tags, old.file_path, COALESCE(old.parent,''));
    END;
  `);

  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS snapshots_fts USING fts5(
      title, content, tags,
      content='snapshots', content_rowid='id',
      tokenize='unicode61 remove_diacritics 2'
    );

    CREATE TRIGGER IF NOT EXISTS snapshots_ai AFTER INSERT ON snapshots BEGIN
      INSERT INTO snapshots_fts(rowid, title, content, tags)
      VALUES (new.id, new.title, new.content, new.tags);
    END;

    CREATE TRIGGER IF NOT EXISTS snapshots_ad AFTER DELETE ON snapshots BEGIN
      INSERT INTO snapshots_fts(snapshots_fts, rowid, title, content, tags)
      VALUES ('delete', old.id, old.title, old.content, old.tags);
    END;
  `);
}

export function createDocChunksFtsIfReady(db: DB): void {
  try {
    db.exec(`SELECT 1 FROM doc_chunks LIMIT 1`);
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS doc_chunks_fts USING fts5(
        content, summary, heading_path,
        content='doc_chunks', content_rowid='id',
        tokenize='unicode61 remove_diacritics 2'
      );

      CREATE TRIGGER IF NOT EXISTS doc_chunks_ai AFTER INSERT ON doc_chunks BEGIN
        INSERT INTO doc_chunks_fts(rowid, content, summary, heading_path)
        VALUES (new.id, new.content, COALESCE(new.summary,''), COALESCE(new.heading_path,''));
      END;

      CREATE TRIGGER IF NOT EXISTS doc_chunks_ad AFTER DELETE ON doc_chunks BEGIN
        INSERT INTO doc_chunks_fts(doc_chunks_fts, rowid, content, summary, heading_path)
        VALUES ('delete', old.id, old.content, COALESCE(old.summary,''), COALESCE(old.heading_path,''));
      END;

      CREATE TRIGGER IF NOT EXISTS doc_chunks_au AFTER UPDATE ON doc_chunks BEGIN
        INSERT INTO doc_chunks_fts(doc_chunks_fts, rowid, content, summary, heading_path)
        VALUES ('delete', old.id, old.content, COALESCE(old.summary,''), COALESCE(old.heading_path,''));
        INSERT INTO doc_chunks_fts(rowid, content, summary, heading_path)
        VALUES (new.id, new.content, COALESCE(new.summary,''), COALESCE(new.heading_path,''));
      END;
    `);

    try {
      const count = (db.prepare('SELECT COUNT(*) as c FROM doc_chunks_fts').get() as { c: number }).c;
      if (count === 0) {
        const chunkCount = (db.prepare('SELECT COUNT(*) as c FROM doc_chunks').get() as { c: number }).c;
        if (chunkCount > 0) {
          db.exec(
            `INSERT INTO doc_chunks_fts(rowid, content, summary, heading_path)
             SELECT id, content, COALESCE(summary,''), COALESCE(heading_path,'') FROM doc_chunks`,
          );
        }
      }
    } catch { /* ignore */ }
  } catch { /* doc_chunks table not yet created — migration 086 not yet applied */ }
}
