/**
 * Golden extraction test — the indexing validation harness (plan: "valide
 * toda a indexação"). Writes small per-language fixtures, runs the REAL
 * structural index (tree-sitter + sqlite, no provider), and asserts the DB
 * rows: symbols (name/kind/namespace/exported), relations (extends /
 * implements / mixes-traits), cross-file references and file_dependencies.
 *
 * Golden values are nominal (names/kinds), not positional — stable across
 * grammar upgrades. Requires the node ABI (better-sqlite3): run after
 * `pnpm node:rebuild` with the app closed.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { makeHarness, type Harness } from './index-agent-harness.js';
import { runStructuralIndex } from '../structural.js';
import type { DBSymbol } from '@mcp/shared/types.js';

let h: Harness;
let all: DBSymbol[];

const sym = (name: string) => all.find((s) => s.name === name)!;

beforeAll(async () => {
  h = makeHarness();
  h.writeFile('UserService.php', [
    '<?php',
    'namespace App\\Services;',
    '',
    'trait Loggable {',
    '    public function log(string $msg): void {}',
    '}',
    '',
    'interface Repository {',
    '    public function find(int $id);',
    '}',
    '',
    'class BaseService {',
    '    protected function boot(): void {}',
    '}',
    '',
    'class UserService extends BaseService implements Repository {',
    '    use Loggable;',
    '    public function find(int $id) { return $this->fetch($id); }',
    '    private function fetch(int $id) { return null; }',
    '}',
  ].join('\n'));
  h.writeFile('util.ts', 'export function helper(n: number): number { return n * 2; }\n');
  h.writeFile('main.ts', [
    "import { helper } from './util.js';",
    'export class App {',
    '  run(): number { return helper(1); }',
    '}',
  ].join('\n'));
  h.writeFile('mod.py', 'class Service:\n    def handle(self):\n        pass\n\ndef visible():\n    pass\n');
  h.writeFile('server.go', 'package svc\n\ntype Server struct{}\n\nfunc NewServer() *Server { return &Server{} }\n');
  h.writeFile('App.java', 'package com.acme;\n\npublic class App {\n  public void run() {}\n}\n');
  h.writeFile('Program.cs', 'namespace Acme.App;\n\npublic class Program {\n  public void Main() {}\n}\n');
  h.writeFile('A.kt', 'package com.acme\n\nclass A {\n  fun go() {}\n}\n');
  await runStructuralIndex(h.db, h.projectId);
  all = h.db.listAllSymbols(h.projectId);
}, 60_000);

afterAll(() => h?.dispose());

describe('golden: symbols + namespace persisted', () => {
  it('php: namespace stamped on every symbol in the file', () => {
    for (const name of ['Loggable', 'Repository', 'BaseService', 'UserService', 'find', 'fetch']) {
      expect(sym(name)?.namespace, name).toBe('App\\Services');
    }
    expect(sym('UserService').kind).toBe('class');
    expect(sym('fetch').parent).toBe('UserService');
  });

  it('ts/js: namespace stays NULL (imports resolve by file path)', () => {
    expect(sym('helper').namespace).toBeNull();
    expect(sym('App').namespace).toBeNull();
  });

  it('python/go/java/csharp/kotlin: language-appropriate namespace', () => {
    expect(sym('Service').namespace).toBe('mod');
    expect(sym('visible').namespace).toBe('mod');
    expect(sym('NewServer').namespace).toBe('svc');
    expect(sym('run').namespace).toBe('com.acme');
    expect(sym('Program').namespace).toBe('Acme.App');
    expect(sym('A').namespace).toBe('com.acme');
  });

  it('exported semantics survive the DB round-trip', () => {
    expect(sym('NewServer').exported).toBe(1); // Go uppercase rule
    expect(sym('helper').exported).toBe(1);    // TS export keyword
    expect(sym('fetch').exported).toBe(0);     // PHP private member
  });
});

describe('golden: relations (extends / implements / mixes)', () => {
  it('php class relations, traits included', () => {
    const rels = h.db.getSymbolRelations(sym('UserService').id, h.projectId);
    const byType = (t: string) => rels.filter((r) => r.relation_type === t).map((r) => r.related_symbol_name);
    expect(byType('extends')).toEqual(['BaseService']);
    expect(byType('implements')).toEqual(['Repository']);
    expect(byType('mixes')).toEqual(['Loggable']);
  });

  it('deep member walk sees inherited + trait members', () => {
    const { members, ancestry } = h.db.getClassMembersDeep(h.projectId, 'UserService');
    const names = members.map((m) => m.name);
    expect(names).toContain('find');  // own
    expect(names).toContain('boot');  // from BaseService
    expect(names).toContain('log');   // from trait Loggable
    expect(members.find((m) => m.name === 'boot')?.inherited_from).toBe('BaseService');
    expect(ancestry).toContain('Loggable');
  });

  it('hierarchy queries answer "who extends X"', () => {
    expect(h.db.getSubclasses(h.projectId, 'BaseService').map((s) => s.name)).toEqual(['UserService']);
    expect(h.db.getImplementors(h.projectId, 'Repository').map((s) => s.name)).toEqual(['UserService']);
    expect(h.db.getExtendsChain(h.projectId, 'UserService')).toEqual(['BaseService']);
  });
});

describe('golden: references + file dependencies', () => {
  it('ts cross-file call lands in symbol_references with symbol_id RESOLVED', () => {
    const callers = h.db.getSymbolCallers(h.projectId, 'helper');
    const fromMain = callers.filter((r) => r.referencing_file_path.endsWith('main.ts'));
    expect(fromMain.length).toBeGreaterThan(0);
    expect(fromMain.some((r) => r.symbol_id !== null)).toBe(true);
  });

  it('ts import lands in file_dependencies with target resolved', () => {
    const mainFile = h.db.getFile(h.projectId, 'main.ts');
    const utilFile = h.db.getFile(h.projectId, 'util.ts');
    expect(mainFile && utilFile).toBeTruthy();
    const deps = h.db.getDependencies(mainFile!.id, h.projectId);
    const internal = deps.filter((d) => d.dep_type === 'internal');
    expect(internal.length).toBeGreaterThan(0);
    expect(internal.some((d) => d.target_file_path === 'util.ts')).toBe(true);
  });
});
