import { createRequire } from 'node:module';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DB } from '../types.js';
import { createFileContentsFts } from '../schema/content-fts.js';
import { searchContent } from '../file-contents.js';
import { buildFtsMatch } from '../fts-query.js';

const Database = createRequire(import.meta.url)('better-sqlite3');
describe('compact content FTS candidates', () => {
  let db: DB;
  beforeEach(() => {
    db = new Database(':memory:');
    db.exec('CREATE TABLE files(id INTEGER PRIMARY KEY, project_id INTEGER, path TEXT)');
    createFileContentsFts(db);
    const insert = (id: number, project: number, content: string) => {
      db.prepare('INSERT INTO files VALUES (?, ?, ?)').run(id, project, `file-${id}.ts`);
      db.prepare('INSERT INTO file_contents_fts(rowid, content) VALUES (?, ?)').run(id, content);
    };
    insert(1, 7, 'fixture_marker_001 auth.api.client ação café');
    insert(2, 7, 'fixture_marker_002 other.api.client');
    insert(3, 8, 'fixture_marker_001 auth.api.client');
  });
  afterEach(() => db.close());

  it('finds punctuation-separated identifiers without unsupported phrase errors', () => {
    for (const query of ['fixture_marker_001', 'auth.api.client', 'ação café', 'ação café']) {
      expect(searchContent(db, 7, buildFtsMatch(query)).map(row => row.id)).toEqual([1]);
    }
  });

  it('preserves OR between phrases and AND within each identifier', () => {
    expect(searchContent(db, 7, buildFtsMatch('fixture_marker_001 fixture_marker_002', 'OR'))
      .map(row => row.id).sort()).toEqual([1, 2]);
    expect(searchContent(db, 7, buildFtsMatch('fixture_marker_001 other.api.client'))).toEqual([]);
  });

  it('bounds results, isolates projects and treats punctuation-only input as empty', () => {
    expect(searchContent(db, 7, buildFtsMatch('fixture'), 1)).toHaveLength(1);
    expect(searchContent(db, 9, buildFtsMatch('fixture'))).toEqual([]);
    expect(searchContent(db, 7, buildFtsMatch('--- : () *'))).toEqual([]);
  });
});
