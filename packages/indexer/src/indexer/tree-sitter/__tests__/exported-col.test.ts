/**
 * Migration 141 metadata: per-language `exported` semantics + 1-based col.
 * Pure tree-sitter (WASM) — no sqlite, runs regardless of native ABI state.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { TreeSitterExtractor } from '../extractor.js';
import { initTreeSitter } from '../languages.js';
import type { LLMSymbol } from '@mcp/shared/types.js';

let extractor: TreeSitterExtractor;

beforeAll(async () => {
  await initTreeSitter();
  extractor = new TreeSitterExtractor();
});

afterAll(() => extractor.dispose());

async function symbolsOf(file: string, code: string): Promise<LLMSymbol[]> {
  const r = await extractor.extract(file, code);
  expect(r.supported).toBe(true);
  return r.analysis.symbols ?? [];
}

const byName = (syms: LLMSymbol[], name: string) => syms.find((s) => s.name === name)!;

describe('exported + col per language', () => {
  it('typescript: export keyword decides; col/end_line populated', async () => {
    const syms = await symbolsOf('a.ts', [
      'export function pub(): number { return 1; }',
      'function priv(): number {',
      '  return 2;',
      '}',
      'export const arrowFn = () => 3;',
      'const localConst = 4;',
    ].join('\n'));
    expect(byName(syms, 'pub').exported).toBe(true);
    expect(byName(syms, 'priv').exported).toBe(false);
    expect(byName(syms, 'arrowFn').exported).toBe(true);
    expect(byName(syms, 'localConst').exported).toBe(false);
    expect(byName(syms, 'priv').col).toBe(1);          // line start
    expect(byName(syms, 'pub').col).toBeGreaterThan(1); // after "export "
    expect(byName(syms, 'priv').end_line).toBe(4);
  });

  it('python: top-level non-underscore is public by convention', async () => {
    const syms = await symbolsOf('m.py', [
      'def visible():',
      '    pass',
      '',
      'def _hidden():',
      '    pass',
    ].join('\n'));
    expect(byName(syms, 'visible').exported).toBe(true);
    expect(byName(syms, '_hidden').exported).toBe(false);
  });

  it('go: the uppercase rule IS the language rule', async () => {
    const syms = await symbolsOf('m.go', [
      'package main',
      'func Public() {}',
      'func private() {}',
    ].join('\n'));
    expect(byName(syms, 'Public').exported).toBe(true);
    expect(byName(syms, 'private').exported).toBe(false);
  });

  it('php: public-by-default; only private/protected hide members', async () => {
    const syms = await symbolsOf('c.php', [
      '<?php',
      'class Svc {',
      '  private function hidden() {}',
      '  protected function semi() {}',
      '  public function open() {}',
      '  function defaultPublic() {}',
      '}',
    ].join('\n'));
    expect(byName(syms, 'Svc').exported).toBe(true);
    expect(byName(syms, 'hidden').exported).toBe(false);
    expect(byName(syms, 'semi').exported).toBe(false);
    expect(byName(syms, 'open').exported).toBe(true);
    expect(byName(syms, 'defaultPublic').exported).toBe(true);
  });

  it('rust: pub via visibility_modifier', async () => {
    const syms = await symbolsOf('m.rs', [
      'pub fn open() {}',
      'fn closed() {}',
    ].join('\n'));
    expect(byName(syms, 'open').exported).toBe(true);
    expect(byName(syms, 'closed').exported).toBe(false);
  });
});
