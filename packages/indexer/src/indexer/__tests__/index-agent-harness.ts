/**
 * Shared harness for IndexAgent integration tests: real CodeIndexDB +
 * SqliteVecVectorStore on temp files, real FileScanner/tree-sitter (WASM),
 * fake LLM provider and fake embedding service with injectable failures.
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodeIndexDB } from '@mcp/store/db.js';
import { SqliteVecVectorStore } from '@mcp/store/sqlite-vec-store.js';
import type { VectorStore } from '@mcp/store/vectors.js';
import { CostTracker } from '@mcp/services/services/costs.js';
import type { AnalysisResult, VectorRecord } from '@mcp/shared/types.js';
import type { IndexerConfig } from '@mcp/shared/utils/config.js';
import { IndexAgent } from '../indexer.js';
import type { LLMProvider } from '../providers/base.js';
import type { EmbeddingService } from '../../search/embeddings.js';

export class FakeProvider implements LLMProvider {
  readonly name = 'fake';
  readonly model = 'fake-1';
  async analyzeFile(filePath: string, _content: string): Promise<AnalysisResult> {
    return {
      analysis: {
        language: 'typescript',
        summary: `Summary of ${filePath}`,
        concepts: ['testing'],
        dependencies: [], internal_deps: [], external_deps: [],
        notes: [], complexity: 'low', layer: 'business',
        is_entry_point: false, is_test: false, is_generated: false,
        symbols: [], references: [],
      },
      inputTokens: 10,
      outputTokens: 5,
    } as unknown as AnalysisResult;
  }
}

function fakeVector(text: string): number[] {
  const v = new Array(8).fill(0);
  for (let i = 0; i < text.length; i++) v[i % 8] += text.charCodeAt(i) % 13;
  const norm = Math.hypot(...v) || 1;
  return v.map((x) => x / norm);
}

export class FakeEmbeddingService implements EmbeddingService {
  calls = 0;
  /** Return true to make the Nth (0-based) embed() call throw. */
  failOn: ((callIndex: number) => boolean) | null = null;
  private fp: string;
  constructor(fingerprint = 'fake:v1') { this.fp = fingerprint; }
  setFingerprint(fp: string): void { this.fp = fp; }
  async embed(texts: string[]): Promise<{ vectors: number[][]; tokens: number }> {
    const idx = this.calls++;
    if (this.failOn?.(idx)) throw new Error(`fake embed failure (call ${idx})`);
    return { vectors: texts.map(fakeVector), tokens: texts.length * 5 };
  }
  async embedQuery(text: string): Promise<{ vector: number[]; tokens: number }> {
    return { vector: fakeVector(text), tokens: 5 };
  }
  fingerprint(): string { return this.fp; }
  maxConcurrency(): number { return 2; }
}

/** Wraps the real sqlite-vec store with per-operation failure switches. */
export class FailableVectorStore implements VectorStore {
  failUpserts = false;
  failDeletes = false;
  constructor(readonly inner: SqliteVecVectorStore) {}
  async upsert(records: VectorRecord[], namespace?: string): Promise<number> {
    if (this.failUpserts) throw new Error('fake upsert failure');
    return this.inner.upsert(records, namespace);
  }
  search(vector: number[], options?: { topK?: number; filter?: Record<string, string>; namespace?: string }) {
    return this.inner.search(vector, options);
  }
  async deleteByIds(ids: string[], namespace?: string): Promise<number> {
    if (this.failDeletes) throw new Error('fake delete failure');
    return this.inner.deleteByIds(ids, namespace);
  }
  isAvailable(): Promise<boolean> { return this.inner.isAvailable(); }
  listIds(namespace?: string): Promise<string[]> { return this.inner.listIds(namespace); }
}

export interface Harness {
  dir: string;
  projectRoot: string;
  projectId: number;
  db: CodeIndexDB;
  vectorStore: FailableVectorStore;
  embedding: FakeEmbeddingService;
  agent: IndexAgent;
  writeFile(name: string, content: string): void;
  deleteFile(name: string): void;
  dispose(): void;
}

export function makeHarness(opts?: { fingerprint?: string }): Harness {
  // In-process tree-sitter + sequential chunks keep tests deterministic.
  process.env.MCP_INDEX_WORKERS = '0';
  process.env.MCP_EMBED_CONCURRENCY = '1';

  const dir = mkdtempSync(join(tmpdir(), 'mcp-idx-harness-'));
  const projectRoot = join(dir, 'proj');
  mkdirSync(projectRoot);

  const db = new CodeIndexDB(join(dir, 'index.db'));
  const project = db.createProject('harness', projectRoot);
  const vectorStore = new FailableVectorStore(new SqliteVecVectorStore({ path: join(dir, 'vec.db') }));
  const embedding = new FakeEmbeddingService(opts?.fingerprint);

  const config = {
    dbPath: join(dir, 'index.db'),
    concurrency: 2,
    maxFileSize: 200,
    ignorePatterns: [],
    indexProfile: 'balanced',
  } as unknown as IndexerConfig;

  const agent = new IndexAgent(db, new FakeProvider(), embedding, vectorStore, new CostTracker(db), null, config);

  return {
    dir,
    projectRoot,
    projectId: project.id,
    db,
    vectorStore,
    embedding,
    agent,
    writeFile: (name, content) => writeFileSync(join(projectRoot, name), content, 'utf-8'),
    deleteFile: (name) => unlinkSync(join(projectRoot, name)),
    dispose: () => {
      try { db.close(); } catch { /* already closed */ }
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* tmp leak is fine */ }
    },
  };
}

/**
 * A TypeScript file whose single exported function body exceeds the 2500-char
 * window → buildEmbeddingCandidates emits MULTIPLE sb_ windows for it.
 */
export function bigFunctionFixture(name = 'bigFn'): string {
  const lines: string[] = [`export function ${name}(input: number): number {`, '  let acc = input;'];
  for (let i = 0; i < 90; i++) {
    lines.push(`  acc = acc + ${i}; // step ${i} keeps the body long enough to span several sliding windows`);
  }
  lines.push('  return acc;', '}');
  return lines.join('\n');
}

export function smallFileFixture(fnName: string): string {
  return [
    `export function ${fnName}(a: number, b: number): number {`,
    '  const sum = a + b;',
    '  const double = sum * 2;',
    '  const triple = sum * 3;',
    '  const quad = sum * 4;',
    '  const penta = sum * 5;',
    '  const hexa = sum * 6;',
    '  const hepta = sum * 7;',
    '  return double + triple + quad + penta + hexa + hepta;',
    '}',
    '',
  ].join('\n');
}
