import { expect, it } from 'vitest';
import { Database } from '../db/types.js';
import { EMBEDDING_PAGE_SIZE, readEmbeddingFiles, type EmbeddingFile, type EmbeddingFileBounds } from '../db/embedding-files.js';

it('keeps the folder and the high-water mark across pages when files change during inference', () => {
  const db = new Database(':memory:');
  try {
    db.exec('CREATE TABLE files(id INTEGER PRIMARY KEY AUTOINCREMENT, project_id INTEGER, path TEXT, language TEXT, UNIQUE(project_id, path))');
    const insert = db.prepare("INSERT INTO files(project_id,path,language) VALUES(?,?,'cpp')");
    for (let i = 0; i < EMBEDDING_PAGE_SIZE + 3; i++) insert.run(1, 'src/' + String(i).padStart(4, '0'));
    insert.run(1, 'src-other/excluded');
    insert.run(2, 'src/foreign');
    const { total, maxId } = readEmbeddingFiles(db, 1, { kind: 'bounds', folders: ['src'] }) as EmbeddingFileBounds;
    expect(total).toBe(EMBEDDING_PAGE_SIZE + 3);
    const page = (after: string) => readEmbeddingFiles(db, 1, { kind: 'page', folder: 'src', after, maxId }) as EmbeddingFile[];
    const first = page('');
    expect(first).toHaveLength(EMBEDDING_PAGE_SIZE);
    insert.run(1, 'src/new-after-start');
    db.prepare('DELETE FROM files WHERE project_id=1 AND path=?').run('src/0256');
    const second = page(first.at(-1)!.path);
    expect(second.map(x => x.path)).toEqual(['src/0257', 'src/0258']);
    expect(page(second.at(-1)!.path)).toEqual([]);
    expect(Object.keys(first[0]!).sort()).toEqual(['id', 'language', 'path']);
  } finally { db.close(); }
});
