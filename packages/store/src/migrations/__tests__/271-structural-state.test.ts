import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { structuralState271 } from '../271-structural-state.js';
import { readStructuralRevision, structuralJournal } from '../../db/structural-state.js';

describe('structural journal and revisions', () => {
  it('replays unacknowledged versions and fences an old acknowledgement', () => {
    const db = new Database(':memory:');
    try {
      structuralState271.up(db);
      const journal = structuralJournal(db);
      const entry = { path: 'á/a.ts', kind: 'upsert' as const, version: 1 };
      journal.put(1, [entry]);
      expect(structuralJournal(db).load(1)).toEqual([entry]);
      journal.put(1, [{ ...entry, version: 2 }]);
      journal.ack(1, [entry]);
      expect(journal.load(1)[0].version).toBe(2);
      expect(journal.load(2)).toEqual([]);
    } finally { db.close(); }
  });
  it('publishes structural revisions in the same transaction, ignoring mtime touches', () => {
    const db = new Database(':memory:');
    try {
      db.exec('CREATE TABLE files(id INTEGER PRIMARY KEY, project_id INTEGER, path TEXT, content_hash TEXT, mtime_ms INTEGER)');
      structuralState271.up(db);
      db.exec("INSERT INTO files VALUES (1, 7, 'a.ts', 'a', 1)");
      const before = readStructuralRevision(db, 7);
      db.exec('UPDATE files SET mtime_ms=2');
      expect(readStructuralRevision(db, 7)).toBe(before);
      expect(() => db.transaction(() => {
        db.exec("UPDATE files SET content_hash='b'");
        throw new Error('rollback');
      })()).toThrow('rollback');
      expect(readStructuralRevision(db, 7)).toBe(before);
      db.exec("UPDATE files SET content_hash='c'");
      expect(readStructuralRevision(db, 7)).not.toBe(before);
      expect(readStructuralRevision(db, 8)).toBe('empty');
      const updated = readStructuralRevision(db, 7);
      db.exec('DELETE FROM files');
      expect(readStructuralRevision(db, 7)).not.toBe(updated);
    } finally { db.close(); }
  });
});
