import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { CENTRAL_DROP_TABLES } from '../../project-db/trim/drop-list.js';
import { coderRoundFileSnapshots222 } from '../222_coder_round_file_snapshots.js';

describe('migration 222 coder round file snapshots', () => {
  it('is a no-op on an already-trimmed project database', () => {
    const db = new Database(':memory:');
    try {
      expect(() => coderRoundFileSnapshots222.up(db)).not.toThrow();
      const tables = db.prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'session_file_%'",
      ).all();
      expect(tables).toEqual([]);
    } finally {
      db.close();
    }
  });

  it('classifies every new round table as central-only', () => {
    expect(CENTRAL_DROP_TABLES).toEqual(expect.arrayContaining([
      'session_file_round_snapshots',
      'session_file_round_hunk_decisions',
      'session_file_round_review_findings',
    ]));
  });
});
