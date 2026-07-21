import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import type DatabaseConstructor from 'better-sqlite3';
import { coderSessions004 } from '@mcp/store/migrations/004_coder_sessions.js';
import { sessionFilesystemRoots249 } from '@mcp/store/migrations/249_session_filesystem_roots.js';
import * as roots from '../filesystem-roots.js';

type DB = InstanceType<typeof DatabaseConstructor>;
let db: DB;

function session(): number {
  return Number(db.prepare(`
    INSERT INTO coder_sessions (project_id, title, provider, model)
    VALUES (1, 'roots', 'test', 'test')
  `).run().lastInsertRowid);
}

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec('CREATE TABLE projects (id INTEGER PRIMARY KEY, name TEXT); INSERT INTO projects VALUES (1, \'one\');');
  coderSessions004.up(db);
  sessionFilesystemRoots249.up(db);
});

afterEach(() => db.close());

describe('session filesystem roots store', () => {
  it('upserts access without duplicating the path', () => {
    const id = session();
    const first = roots.upsert(db, id, 'C:\\external', 'read');
    const second = roots.upsert(db, id, 'C:\\external', 'write');

    expect(second.id).toBe(first.id);
    expect(roots.list(db, id)).toHaveLength(1);
    expect(roots.list(db, id)[0].access).toBe('write');
  });

  it('copies grants and cascades them when the target session is deleted', () => {
    const source = session();
    const target = session();
    roots.upsert(db, source, 'C:\\one', 'read');
    roots.upsert(db, source, 'C:\\two', 'write');
    roots.copy(db, source, target);

    expect(roots.list(db, target).map((root) => root.access)).toEqual(['read', 'write']);
    db.prepare('DELETE FROM coder_sessions WHERE id = ?').run(target);
    expect(roots.list(db, target)).toEqual([]);
  });
});
