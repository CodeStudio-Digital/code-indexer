/**
 * Call-graph extraction — runs real tree-sitter (wasm) so it exercises the
 * full extract() path. No DB / better-sqlite3, so it runs under plain Node
 * regardless of the native ABI the desktop build is on.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { TreeSitterExtractor } from '../extractor.js';

const extractor = new TreeSitterExtractor();
afterAll(() => extractor.dispose());

function refNames(res: Awaited<ReturnType<TreeSitterExtractor['extract']>>): string[] {
  return (res.analysis.references ?? []).map((r) => r.symbol_name);
}

describe('call-graph extraction', () => {
  it('captures calls to locally-defined and imported names (TypeScript)', async () => {
    const code = [
      `import { helper } from './util';`,
      `function compute() { return 1; }`,
      `export function doWork() {`,
      `  helper();`,
      `  const n = compute();`,
      `  console.log(n);`,
      `  return n;`,
      `}`,
    ].join('\n');

    const res = await extractor.extract('sample.ts', code);
    expect(res.supported).toBe(true);
    const names = refNames(res);
    expect(names).toContain('helper');   // imported → known
    expect(names).toContain('compute');  // locally defined → known
    // console.log resolves to `log`, which is neither defined nor imported.
    expect(names).not.toContain('log');
    expect(names).not.toContain('console');
  });

  it('resolves member calls to the invoked member and records the call line', async () => {
    const code = [
      `import { repo } from './db';`,
      `function save() { repo.insert(); }`,
      `function insert() {}`,
    ].join('\n');
    const res = await extractor.extract('m.ts', code);
    // `repo.insert()` → callee resolves to `insert` (a known local symbol).
    const callRefs = (res.analysis.references ?? []).filter((r) => r.symbol_name === 'insert');
    expect(callRefs.length).toBeGreaterThan(0);
    expect(callRefs.some((r) => typeof r.line === 'number' && (r.line as number) > 0)).toBe(true);
  });

  it('captures calls across a non-TS language (Python) and skips builtins', async () => {
    const code = [
      `def helper():`,
      `    return 1`,
      ``,
      `def main():`,
      `    helper()`,
      `    print("hi")`,
    ].join('\n');
    const res = await extractor.extract('sample.py', code);
    expect(res.supported).toBe(true);
    const names = refNames(res);
    expect(names).toContain('helper');     // local def, then called
    expect(names).not.toContain('print');  // builtin, not defined/imported
  });
});
