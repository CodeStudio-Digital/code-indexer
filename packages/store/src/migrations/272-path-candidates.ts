import type { Migration } from './types.js';

export const pathCandidates272: Migration = {
  version: 272,
  name: 'indexed_path_candidates',
  up(db) {
    db.exec(`CREATE INDEX IF NOT EXISTS idx_files_path_nocase ON files(project_id, path COLLATE NOCASE);
      CREATE INDEX IF NOT EXISTS idx_files_basename_nocase ON files(project_id,
        substr(path,length(rtrim(path,replace(path,'/','')))+1) COLLATE NOCASE);
      CREATE VIRTUAL TABLE IF NOT EXISTS file_paths_fts USING fts5(path, content='files', content_rowid='id', tokenize='trigram');
      CREATE TRIGGER IF NOT EXISTS file_paths_insert AFTER INSERT ON files BEGIN
        INSERT INTO file_paths_fts(rowid,path) VALUES(new.id,new.path); END;
      CREATE TRIGGER IF NOT EXISTS file_paths_delete AFTER DELETE ON files BEGIN
        INSERT INTO file_paths_fts(file_paths_fts,rowid,path) VALUES('delete',old.id,old.path); END;
      CREATE TRIGGER IF NOT EXISTS file_paths_update AFTER UPDATE OF path ON files WHEN old.path IS NOT new.path BEGIN
        INSERT INTO file_paths_fts(file_paths_fts,rowid,path) VALUES('delete',old.id,old.path);
        INSERT INTO file_paths_fts(rowid,path) VALUES(new.id,new.path); END;
      INSERT INTO file_paths_fts(file_paths_fts) VALUES('rebuild');`);
  },
};
