import { describe, it, expect } from 'vitest';
import { findTerminalPathMatches } from '../terminal-links.js';

describe('findTerminalPathMatches', () => {
  it('matches a relative path with :line:col and reports offsets', () => {
    const line = '  at src/app/main.ts:42:7 (in handler)';
    const [m, ...rest] = findTerminalPathMatches(line);
    expect(rest).toEqual([]);
    expect(m).toMatchObject({ path: 'src/app/main.ts', line: 42, column: 7 });
    expect(line.slice(m!.startX, m!.endX)).toBe('src/app/main.ts:42:7');
  });

  it('matches a relative path with :line only, and a bare relative path (has separator)', () => {
    expect(findTerminalPathMatches('ERROR packages/x/y.tsx:10')[0]).toMatchObject({ path: 'packages/x/y.tsx', line: 10 });
    expect(findTerminalPathMatches('see ./lib/util.js for details')[0]).toMatchObject({ path: 'lib/util.js' });
  });

  it('normalizes backslashes and strips a ./ prefix', () => {
    expect(findTerminalPathMatches('.\\src\\a.ts:3')[0]).toMatchObject({ path: 'src/a.ts', line: 3 });
  });

  it('links a bare filename ONLY when it carries a location', () => {
    expect(findTerminalPathMatches('a.ts:5 failed')[0]).toMatchObject({ path: 'a.ts', line: 5 });
    // No separator and no location → not a link (prose).
    expect(findTerminalPathMatches('edit config.js and rerun')).toEqual([]);
  });

  it('skips absolute paths (Windows drive, POSIX, WSL /mnt) in v1', () => {
    expect(findTerminalPathMatches('C:\\proj\\src\\a.ts:1')).toEqual([]);
    expect(findTerminalPathMatches('/home/u/proj/src/a.ts:1')).toEqual([]);
    expect(findTerminalPathMatches('/mnt/d/MCP/src/a.ts:9')).toEqual([]);
  });

  it('finds multiple matches on one line', () => {
    const matches = findTerminalPathMatches('src/a.ts:1 and lib/b.js:2');
    expect(matches.map((x) => x.path)).toEqual(['src/a.ts', 'lib/b.js']);
    expect(matches.map((x) => x.line)).toEqual([1, 2]);
  });
});
