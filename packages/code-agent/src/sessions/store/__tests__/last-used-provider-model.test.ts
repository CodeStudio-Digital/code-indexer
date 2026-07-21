import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { getLastUsedProviderModel } from '../sessions-core.js';

let db: Database.Database | undefined;

beforeEach(() => {
  db = new Database(':memory:');
  db.exec(`
    CREATE TABLE coder_sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      provider TEXT NOT NULL,
      model TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);
});

afterEach(() => db?.close());

describe('getLastUsedProviderModel', () => {
  it('uses actual recency instead of favorite/list ordering', () => {
    db!.prepare('INSERT INTO coder_sessions (provider, model, updated_at) VALUES (?, ?, ?)')
      .run('openai', 'gpt-old', '2026-07-14 10:00:00');
    db!.prepare('INSERT INTO coder_sessions (provider, model, updated_at) VALUES (?, ?, ?)')
      .run('zai', 'glm-5.2', '2026-07-14 12:00:00');

    expect(getLastUsedProviderModel(db!)).toEqual({ provider: 'zai', model: 'glm-5.2' });
  });

  it('ignores incomplete rows and uses id as the stable tie-breaker', () => {
    db!.prepare('INSERT INTO coder_sessions (provider, model, updated_at) VALUES (?, ?, ?)')
      .run('openai', 'gpt-5', '2026-07-14 12:00:00');
    db!.prepare('INSERT INTO coder_sessions (provider, model, updated_at) VALUES (?, ?, ?)')
      .run('zai', 'glm-5.2', '2026-07-14 12:00:00');
    db!.prepare('INSERT INTO coder_sessions (provider, model, updated_at) VALUES (?, ?, ?)')
      .run('broken', '', '2026-07-14 13:00:00');

    expect(getLastUsedProviderModel(db!)).toEqual({ provider: 'zai', model: 'glm-5.2' });
  });

  it('skips whitespace-only rows (legacy trim() semantics, now enforced in JS)', () => {
    // The mig-246 sargable rewrite dropped trim() from the SQL predicate so the
    // scan can ride idx_coder_sessions_updated; whitespace-only values must
    // still be rejected — by the JS loop over the streamed rows.
    db!.prepare('INSERT INTO coder_sessions (provider, model, updated_at) VALUES (?, ?, ?)')
      .run('zai', 'glm-5.2', '2026-07-14 12:00:00');
    db!.prepare('INSERT INTO coder_sessions (provider, model, updated_at) VALUES (?, ?, ?)')
      .run('   ', 'ghost-model', '2026-07-14 13:00:00');
    db!.prepare('INSERT INTO coder_sessions (provider, model, updated_at) VALUES (?, ?, ?)')
      .run('ghost-provider', ' \t ', '2026-07-14 14:00:00');

    expect(getLastUsedProviderModel(db!)).toEqual({ provider: 'zai', model: 'glm-5.2' });
  });

  it('returns null when no complete row exists', () => {
    db!.prepare('INSERT INTO coder_sessions (provider, model, updated_at) VALUES (?, ?, ?)')
      .run('', '', '2026-07-14 12:00:00');
    db!.prepare('INSERT INTO coder_sessions (provider, model, updated_at) VALUES (?, ?, ?)')
      .run('  ', 'model', '2026-07-14 13:00:00');

    expect(getLastUsedProviderModel(db!)).toBeNull();
  });
});
