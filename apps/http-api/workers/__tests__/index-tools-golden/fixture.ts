import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { CodeIndexDB } from '@mcp/store/db.js';
import { DocStore } from '@mcp/store/doc-store.js';
import type { LLMSymbol, Project } from '@mcp/shared/types.js';

/** Two indexed projects on disk plus memories, costs and a linked doc collection. */
export interface ParityFixture {
  base: string;
  root: string;
  secondRoot: string;
  db: CodeIndexDB;
  main: Project;
  second: Project;
  ids: { target: number; memories: number[]; chunks: number[] };
  close(): void;
}

const lines = (count: number, at: Record<number, string>) =>
  Array.from({ length: count }, (_, i) => at[i + 1] ?? `// filler ${i + 1}`).join('\n') + '\n';

export const TARGET = lines(120, {
  10: 'export function target() {', 11: '  return PUBLIC_LIMIT;', 12: '}',
  30: 'export interface Shape {', 31: '  area(): number;', 32: '}',
  40: 'export class Widget implements Shape {', 41: '  area() { return 1; }', 42: '}',
  100: 'export const PUBLIC_LIMIT = 17;',
});
const CALLER = "import { target } from './target';\n\nexport const a = target();\nexport const b = target();\nexport const c = target();\n";
const CALLER_TEST = "import { target } from './target';\n\ntarget();\n";
const BIG = lines(900, { 603: 'export function next() {', 604: '  return 603;', 605: '}' });
const NEW_FILE = "export function onlyOnDisk() {\n  return 'NEW_ONLY';\n}\n";
const DUPE = 'function dupe() {\n  return 1;\n}\n';
const HUGE_LINE = 'abcdefghijklmnopqrstuvwxyz0123456789\n';

function symbol(name: string, kind: string, line: number, endLine: number, extra: Partial<LLMSymbol> = {}): LLMSymbol {
  return { name, kind, signature: `${name}()`, parent: null, line, end_line: endLine, modifiers: [], return_type: null,
    parameters: null, exported: true, comment: null, tags: [], ...extra } as LLMSymbol;
}

/** Build one independent copy (its own folder and database). */
export function buildParityFixture(label: string): ParityFixture {
  const base = mkdtempSync(join(tmpdir(), `parity-${label}-`));
  const root = join(base, 'main');
  const secondRoot = join(base, 'second');
  const write = (dir: string, path: string, content: string | Buffer) => {
    const abs = join(dir, path);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  };
  const indexed: Record<string, string> = {
    'src/target.ts': TARGET, 'src/caller.ts': CALLER, 'src/caller.test.ts': CALLER_TEST, 'src/big.ts': BIG,
    'docs/readme.md': 'This guide mentions target once.\n', 'license-configuration.json': '{ "mode": "fixture" }\n',
    'src/dup-a.ts': DUPE, 'src/dup-b.ts': DUPE, 'src/repeat.txt': 'repeat-me line\n'.repeat(1000),
  };
  for (const [path, content] of Object.entries(indexed)) write(root, path, content);
  write(root, 'src/new-file.ts', NEW_FILE);
  write(root, 'src/huge.txt', HUGE_LINE.repeat(Math.ceil((2.5 * 1024 * 1024) / HUGE_LINE.length)));
  write(root, 'assets/blob.bin', Buffer.from(Array.from({ length: 64 }, (_, i) => i)));
  write(secondRoot, 'lib/a.ts', 'export const SECOND = 1;\n');
  write(secondRoot, 'lib/b.ts', 'export const OTHER = 2;\n');

  const db = new CodeIndexDB(join(base, 'index.db'));
  const main = db.createProject('parity-main', root);
  const second = db.createProject('parity-second', secondRoot);
  const language = (path: string) => path.endsWith('.ts') ? 'typescript' : path.endsWith('.md') ? 'markdown'
    : path.endsWith('.txt') ? 'text' : 'json';
  const index = (project: Project, path: string, content: string) => {
    const id = db.upsertFile(project.id, { path, language: language(path), size: Buffer.byteLength(content),
      lineCount: content.split('\n').length - 1, contentHash: `fixture-${path}`, isTest: path.includes('.test.') });
    db.upsertFileContent(id, content, Buffer.byteLength(content), project.id);
    return id;
  };
  const ids = Object.fromEntries(Object.entries(indexed).map(([path, content]) => [path, index(main, path, content)]));
  db.upsertFile(main.id, { path: 'src/huge.txt', language: 'text', size: 2.5 * 1024 * 1024, lineCount: 70_000, contentHash: 'fixture-huge' });

  db.upsertSymbols(main.id, ids['src/target.ts'], 'src/target.ts', [
    symbol('target', 'function', 10, 12), symbol('Shape', 'interface', 30, 32),
    symbol('Widget', 'class', 40, 42, { implements_list: ['Shape'] }), symbol('PUBLIC_LIMIT', 'constant', 100, 100),
  ]);
  db.upsertSymbols(main.id, ids['src/big.ts'], 'src/big.ts', [symbol('next', 'function', 603, 605)]);
  for (const path of ['src/dup-a.ts', 'src/dup-b.ts']) db.upsertSymbols(main.id, ids[path], path, [symbol('dupe', 'function', 1, 3, { exported: false })]);
  for (const [path, calls] of [['src/caller.ts', [3, 4, 5]], ['src/caller.test.ts', [3]]] as const) {
    db.upsertSymbolReferences(main.id, ids[path], path, [
      { symbol_name: 'target', kind: 'import', reference_kind: 'import', line: 1 },
      ...calls.map(line => ({ symbol_name: 'target', kind: 'call', reference_kind: 'call' as const, line })),
    ]);
    db.upsertFileDependencies(main.id, ids[path], path, ['./target'], []);
  }
  const secondA = index(second, 'lib/a.ts', 'export const SECOND = 1;\n');
  db.upsertSymbols(second.id, secondA, 'lib/a.ts', [symbol('SECOND', 'constant', 1, 1)]);
  index(second, 'lib/b.ts', 'export const OTHER = 2;\n');

  const memories = (['decision', 'gotcha', 'convention'] as const).map((type, i) => db.createAgentMemory({
    scope: 'project', projectId: main.id, name: `parity-${type}`, type, importance: 0.5 + i / 10,
    content: `Parity ${type} memory ${i}: the target function returns PUBLIC_LIMIT for every widget.`,
  }).id);
  const cost = { projectId: main.id, provider: 'fixture', model: 'test', operation: 'embedding' as const,
    inputTokens: 20, outputTokens: 0, costUsd: 0.5 };
  db.insertCost(cost);
  db.insertCost({ ...cost, costUsd: 1.25 });

  const docs = new DocStore(db.raw());
  const collection = docs.createCollection({ name: 'parity-docs' }).id;
  docs.linkProjectCollection(second.id, collection);
  const source = docs.createSource({ collection_id: collection, type: 'url', uri: 'https://docs.example/segundo' }).id;
  const chunks = docs.insertChunks([0, 1].map(ord => ({ collection_id: collection, source_id: source, ord,
    content: ord === 0 ? 'Primeiro trecho do guia segundo.' : 'Outro trecho do guia segundo, com detalhes.',
    content_hash: `parity-${ord}`, heading_path: ord === 0 ? 'Inicio' : 'Detalhes', token_count: 6 })));

  return {
    base, root, secondRoot, db, main, second,
    ids: { target: targetSymbolId(db, main.id), memories, chunks },
    close() { db.close(); rmSync(base, { recursive: true, force: true }); },
  };
}

function targetSymbolId(db: CodeIndexDB, projectId: number): number {
  const row = db.raw().prepare("SELECT id FROM symbols WHERE project_id = ? AND name = 'target'").get(projectId) as { id: number };
  return row.id;
}
