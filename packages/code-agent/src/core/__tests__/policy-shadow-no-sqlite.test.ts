import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('policy shadow persistence boundary', () => {
  it('has no productive SQLite store, query, fallback or dual-write path', async () => {
    const root = join(
      process.cwd(),
      'packages',
      'code-agent',
      'src',
      'core',
    );
    const source = (
      await Promise.all(
        [
          'policy-engine.ts',
          'policy-shadow-adapter.ts',
          'policy-shadow-persistence.ts',
        ].map((file) => readFile(join(root, file), 'utf8')),
      )
    ).join('\n');

    expect(source).not.toMatch(/better-sqlite3/i);
    expect(source).not.toMatch(/@mcp\/store/i);
    expect(source).not.toMatch(/PolicyDecisionStore|CapabilityStore/);
    expect(source).not.toMatch(
      /\bSELECT\b|\bINSERT\s+INTO\b|\bUPDATE\s+\w+\s+SET\b/i,
    );
    expect(source).not.toContain('.prepare(');
    expect(source).not.toMatch(
      /fallback[^\r\n]*sqlite|sqlite[^\r\n]*fallback/i,
    );
  });
});
