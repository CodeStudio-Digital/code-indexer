/**
 * Migration 187: namespace extraction per language + PHP trait mixins.
 * Pure tree-sitter (WASM) — no sqlite, runs regardless of native ABI state.
 * These tests pin the REAL grammar node names (the risk called out in the
 * plan: node types vary across grammar versions).
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

describe('namespace per language', () => {
  it('php: namespace_definition + trait use inside the class body', async () => {
    const syms = await symbolsOf('app/Services/UserService.php', [
      '<?php',
      'namespace App\\Services;',
      'use Illuminate\\Support\\Str;',
      'class UserService {',
      '  use Notifiable, SoftDeletes;',
      '  public function save(): void {}',
      '}',
    ].join('\n'));
    const cls = byName(syms, 'UserService');
    expect(cls.namespace).toBe('App\\Services');
    expect(cls.uses_traits).toEqual(['Notifiable', 'SoftDeletes']);
    expect(byName(syms, 'save').namespace).toBe('App\\Services');
  });

  it('php: file without namespace stays null and traits absent', async () => {
    const syms = await symbolsOf('legacy.php', '<?php\nclass Legacy {}\n');
    expect(byName(syms, 'Legacy').namespace ?? null).toBeNull();
    expect(byName(syms, 'Legacy').uses_traits).toBeUndefined();
  });

  it('go: package_clause', async () => {
    const syms = await symbolsOf('m.go', 'package main\n\nfunc Foo() {}\n');
    expect(byName(syms, 'Foo').namespace).toBe('main');
  });

  it('java: package_declaration', async () => {
    const syms = await symbolsOf('A.java', 'package com.acme.app;\n\npublic class A {}\n');
    expect(byName(syms, 'A').namespace).toBe('com.acme.app');
  });

  it('csharp: file-scoped and block namespaces', async () => {
    const flat = await symbolsOf('A.cs', 'namespace Acme.App;\n\npublic class A {}\n');
    expect(byName(flat, 'A').namespace).toBe('Acme.App');
    const block = await symbolsOf('B.cs', 'namespace Acme {\n  public class B {}\n}\n');
    expect(byName(block, 'B').namespace).toBe('Acme');
  });

  it('kotlin: package_header', async () => {
    const syms = await symbolsOf('A.kt', 'package com.acme\n\nclass A {}\n');
    expect(byName(syms, 'A').namespace).toBe('com.acme');
  });

  it('python: dotted module from the relative path', async () => {
    const syms = await symbolsOf('pkg/mod.py', 'def visible():\n    pass\n');
    expect(byName(syms, 'visible').namespace).toBe('pkg.mod');
    const init = await symbolsOf('pkg/__init__.py', 'def boot():\n    pass\n');
    expect(byName(init, 'boot').namespace).toBe('pkg');
  });

  it('rust: mod path from the relative path; crate roots collapse', async () => {
    const syms = await symbolsOf('src/foo/bar.rs', 'pub fn baz() {}\n');
    expect(byName(syms, 'baz').namespace).toBe('foo::bar');
    const root = await symbolsOf('src/main.rs', 'fn main() {}\n');
    expect(byName(root, 'main').namespace ?? null).toBeNull();
  });

  it('typescript: no namespace (imports resolve by file path)', async () => {
    const syms = await symbolsOf('a.ts', 'export function f() {}\n');
    expect(byName(syms, 'f').namespace ?? null).toBeNull();
  });
});
