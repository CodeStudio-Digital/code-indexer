import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { coderToolOutputFormat213 } from '../213_coder_tool_output_format.js';

function columns(db: Database.Database, table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((row) => row.name);
}

describe('migration 213 — coder tool output format', () => {
  it('adds nullable telemetry columns idempotently', () => {
    const db = new Database(':memory:');
    db.exec('CREATE TABLE coder_tool_calls (id INTEGER PRIMARY KEY)');
    coderToolOutputFormat213.up(db);
    coderToolOutputFormat213.up(db);
    expect(columns(db, 'coder_tool_calls')).toEqual([
      'id',
      'output_format',
      'structured_output_chars',
    ]);
    db.close();
  });

  it('is a no-op for a trimmed project database', () => {
    const db = new Database(':memory:');
    expect(() => coderToolOutputFormat213.up(db)).not.toThrow();
    expect(columns(db, 'coder_tool_calls')).toEqual([]);
    db.close();
  });
});
