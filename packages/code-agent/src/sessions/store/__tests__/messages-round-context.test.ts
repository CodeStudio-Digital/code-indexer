import { afterEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import * as messages from '../messages.js';

const db = new Database(':memory:');
db.exec(`
  CREATE TABLE coder_messages (
    id INTEGER PRIMARY KEY,
    session_id INTEGER NOT NULL,
    role TEXT NOT NULL,
    is_meta INTEGER DEFAULT 0
  );
`);

afterEach(() => {
  db.prepare('DELETE FROM coder_messages').run();
});

describe('previousUserMessageId', () => {
  it('finds an archived user outside the loaded assistant tail and skips meta rows', () => {
    const insert = db.prepare('INSERT INTO coder_messages (id, session_id, role, is_meta) VALUES (?, 1, ?, ?)');
    insert.run(10, 'user', 0);
    insert.run(11, 'user', 1);
    insert.run(12, 'assistant', 0);
    insert.run(20, 'assistant', 0);

    expect(messages.previousUserMessageId(db, 1, 20)).toBe(10);
    expect(messages.previousUserMessageId(db, 2, 20)).toBeNull();
  });
});
