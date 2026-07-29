import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('filesystem session architecture boundary', () => {
  it('contains no SQLite import, query or fallback in fs-store runtime files', async () => {
    const root = join(
      process.cwd(),
      'packages',
      'code-agent',
      'src',
      'sessions',
      'fs-store',
    );
    const files = (await readdir(root))
      .filter((name) => name.endsWith('.ts'))
      .filter((name) => !name.endsWith('.test.ts'));
    const sources = await Promise.all(
      files.map(async (file) => ({
        file,
        source: await readFile(join(root, file), 'utf8'),
      })),
    );
    for (const item of sources) {
      expect(
        item.source.split(/\r?\n/).length,
        `${item.file} must stay below the 500-line module boundary`,
      ).toBeLessThanOrEqual(500);
    }
    const source = sources.map((item) => item.source).join('\n');
    expect(source).not.toMatch(/better-sqlite3/i);
    expect(source).not.toMatch(/\bSELECT\b|\bINSERT\s+INTO\b|\bUPDATE\s+\w+\s+SET\b/i);
    expect(source).not.toContain('.prepare(');
    // Keep the fallback guard file-local and line-local. Concatenating every
    // source file allowed an unrelated `fallback_provider` near the beginning
    // to match a later migration comment mentioning SQLite.
    expect(source).not.toMatch(
      /fallback[^\r\n]*sqlite|sqlite[^\r\n]*fallback/i,
    );
  });
});
