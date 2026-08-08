import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { removeDeadCodeRunSettings266 } from '../266_remove_dead_code_run_settings.js';

let db: InstanceType<typeof Database>;

beforeEach(() => {
  db = new Database(':memory:');
});

afterEach(() => db.close());

describe('migration 266 - remove dead code-run settings', () => {
  it('removes classified dead rows and preserves unrelated/internal settings', () => {
    db.exec(`
      CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT);
      INSERT INTO app_settings (key, value) VALUES
        ('CODER_PROFILE_AUTO', '1'),
        ('MCP_PIPELINES_TOOL_SELECTION', '1'),
        ('CODER_PUSH_TIME_CAP', '48000'),
        ('general_default_model', 'model-x');
    `);

    removeDeadCodeRunSettings266.up(db);
    removeDeadCodeRunSettings266.up(db);

    expect(db.prepare('SELECT key FROM app_settings ORDER BY key').all()).toEqual([
      { key: 'CODER_PUSH_TIME_CAP' },
      { key: 'general_default_model' },
    ]);
  });

  it('is safe before app_settings exists', () => {
    expect(() => removeDeadCodeRunSettings266.up(db)).not.toThrow();
  });
});
