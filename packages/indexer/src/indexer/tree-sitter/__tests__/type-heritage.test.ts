import { afterAll, expect, it } from 'vitest';
import { TreeSitterExtractor, EXTRACTOR_VERSION } from '../extractor.js';

const extractor = new TreeSitterExtractor();
afterAll(() => extractor.dispose());
it('separates nested TypeScript extends/implements clauses and drops generic arguments from relation keys', async () => {
  const source = 'export class Foo<T> extends Base<T> implements One<T>, Two {} interface Child extends One, Two {} class Only implements Port {}';
  const full = await extractor.extract('sample.ts', source), outline = await extractor.outline('sample.ts', source);
  expect(outline.analysis.symbols).toEqual(full.analysis.symbols);
  const [foo, child, only] = full.analysis.symbols!;
  expect(foo).toMatchObject({ name: 'Foo', extends_from: 'Base', implements_list: ['One', 'Two'] });
  expect(child).toMatchObject({ name: 'Child', extends_from: 'One', extends_list: ['One', 'Two'] });
  expect(only).toMatchObject({ name: 'Only', implements_list: ['Port'] }); expect(only.extends_from).toBeUndefined();
  expect(EXTRACTOR_VERSION).toBeGreaterThan(1);
});
it('does not turn JavaScript extends into implements and separates Java interface lists', async () => {
  const js = (await extractor.extract('sample.js', 'class Foo extends Base {}')).analysis.symbols![0];
  expect(js.extends_from).toBe('Base'); expect(js.implements_list).toBeUndefined();
  const java = (await extractor.extract('Sample.java', 'class Foo extends Base<String> implements One<String>, Two {}')).analysis.symbols![0];
  expect(java.extends_from).toBe('Base'); expect(java.implements_list).toEqual(['One', 'Two']);
});
it('distinguishes a named import from actual call sites, including a top-level call', async () => {
  const result = await extractor.extract('references.ts', "import { target } from './target';\nfunction caller() { target(); }\ntarget();");
  expect(result.analysis.references).toEqual(expect.arrayContaining([
    expect.objectContaining({ symbol_name: 'target', reference_kind: 'import', line: 1 }),
    expect.objectContaining({ symbol_name: 'target', reference_kind: 'call', line: 2 }),
    expect.objectContaining({ symbol_name: 'target', reference_kind: 'call', line: 3 }),
  ]));
  expect(EXTRACTOR_VERSION).toBeGreaterThan(2);
});
