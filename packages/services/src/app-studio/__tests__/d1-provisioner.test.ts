import { describe, expect, it } from 'vitest';
import { parseLocalMigrationHistory } from '../d1-migration-history.js';

describe('parseLocalMigrationHistory', () => {
  it('reads Wrangler D1 query JSON even when informational text precedes it', () => {
    expect(parseLocalMigrationHistory(`wrangler info\n[
      {"results":[{"name":"0001_init.sql"},{"name":"0002_users.sql"}],"success":true}
    ]`)).toEqual(['0001_init.sql', '0002_users.sql']);
  });

  it('returns null for output that cannot prove the real migration state', () => {
    expect(parseLocalMigrationHistory('not json')).toBeNull();
    expect(parseLocalMigrationHistory('{"results":[]}')).toBeNull();
  });
});
