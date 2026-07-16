import { mkdtempSync, mkdirSync, rmSync, writeFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodeIndexDB } from '@mcp/store/db.js';
import { SqliteVecVectorStore } from '@mcp/store/sqlite-vec-store.js';
import type { VectorItemState, VectorStore } from '@mcp/store/vectors.js';
import type { VectorRecord } from '@mcp/shared/types.js';
import type { EmbeddingService } from '../../search/embeddings.js';
import { runStructuralIndex } from '../structural.js';

function fakeVector(text: string): number[] {
  const vector = new Array(8).fill(0) as number[];
  for (let index = 0; index < text.length; index++) {
    vector[index % vector.length] += text.charCodeAt(index) % 13;
  }
  const norm = Math.hypot(...vector) || 1;
  return vector.map((value) => value / norm);
}

export class FakeEmbeddingService implements EmbeddingService {
  calls = 0;
  failOn: ((callIndex: number) => boolean) | null = null;
  constructor(private fingerprintValue = 'fake:v1') {}

  setFingerprint(value: string): void { this.fingerprintValue = value; }
  async embed(texts: string[]): Promise<{ vectors: number[][]; tokens: number }> {
    const call = this.calls++;
    if (this.failOn?.(call)) throw new Error(`fake embed failure (call ${call})`);
    return { vectors: texts.map(fakeVector), tokens: texts.length * 5 };
  }
  async embedQuery(text: string): Promise<{ vector: number[]; tokens: number }> {
    return { vector: fakeVector(text), tokens: 5 };
  }
  fingerprint(): string { return this.fingerprintValue; }
  maxConcurrency(): number { return 1; }
}

export class FailableVectorStore implements VectorStore {
  failUpserts = false;
  private readonly items = new Map<string, Map<string, VectorItemState>>();
  constructor(readonly inner: SqliteVecVectorStore) {}

  async upsert(records: VectorRecord[], namespace = ''): Promise<number> {
    if (this.failUpserts) throw new Error('fake upsert failure');
    const accepted = await this.inner.upsert(records, namespace);
    const items = this.items.get(namespace) ?? new Map<string, VectorItemState>();
    for (const record of records.slice(0, accepted)) {
      const itemKey = `${record.metadata.type ?? 'vector'}:${record.metadata.ref_id ?? record.id}`;
      const chunkIndex = Number(record.metadata.chunk_index ?? 0) || 0;
      items.set(`${itemKey}\0${chunkIndex}`, {
        itemKey,
        sourceHash: record.metadata.embedding_hash ?? record.id,
        vectorId: record.id,
        chunkIndex,
        status: 'indexed',
        attempts: 1,
        error: null,
      });
    }
    this.items.set(namespace, items);
    return accepted;
  }
  search(vector: number[], options?: Parameters<SqliteVecVectorStore['search']>[1]) {
    return this.inner.search(vector, options);
  }
  deleteByIds(ids: string[], namespace?: string): Promise<number> {
    return this.inner.deleteByIds(ids, namespace);
  }
  listItems(namespace: string, itemKeys?: string[]): Promise<VectorItemState[]> {
    const keys = itemKeys ? new Set(itemKeys) : null;
    return Promise.resolve([...(this.items.get(namespace)?.values() ?? [])]
      .filter((item) => !keys || keys.has(item.itemKey)));
  }
  async deleteByItemKeys(itemKeys: string[], namespace: string): Promise<number> {
    const keys = new Set(itemKeys);
    const items = this.items.get(namespace);
    if (!items) return 0;
    const ids: string[] = [];
    for (const [identity, item] of items) {
      if (!keys.has(item.itemKey)) continue;
      if (item.vectorId) ids.push(item.vectorId);
      items.delete(identity);
    }
    return this.inner.deleteByIds(ids, namespace);
  }
  isAvailable(): Promise<boolean> { return this.inner.isAvailable(); }
  listIds(namespace?: string): Promise<string[]> { return this.inner.listIds(namespace); }
  clearItems(namespace?: string): void {
    if (namespace) this.items.delete(namespace);
    else this.items.clear();
  }
}

export interface StructuralHarness {
  dir: string;
  projectRoot: string;
  projectId: number;
  db: CodeIndexDB;
  vectorStore: FailableVectorStore;
  embedding: FakeEmbeddingService;
  writeFile(name: string, content: string): void;
  deleteFile(name: string): void;
  indexStructural(): ReturnType<typeof runStructuralIndex>;
  dispose(): void;
}

export function makeStructuralHarness(opts?: { fingerprint?: string }): StructuralHarness {
  process.env.MCP_INDEX_WORKERS = '0';
  process.env.MCP_EMBED_CONCURRENCY = '1';
  const dir = mkdtempSync(join(tmpdir(), 'mcp-structural-harness-'));
  const projectRoot = join(dir, 'project');
  mkdirSync(projectRoot);
  const db = new CodeIndexDB(join(dir, 'index.db'));
  const project = db.createProject('harness', projectRoot);
  const vectorStore = new FailableVectorStore(
    new SqliteVecVectorStore({ path: join(dir, 'vectors.db') }),
  );
  const embedding = new FakeEmbeddingService(opts?.fingerprint);
  return {
    dir,
    projectRoot,
    projectId: project.id,
    db,
    vectorStore,
    embedding,
    writeFile: (name, content) => writeFileSync(join(projectRoot, name), content, 'utf8'),
    deleteFile: (name) => unlinkSync(join(projectRoot, name)),
    indexStructural: () => runStructuralIndex(db, project.id, { concurrency: 1 }),
    dispose: () => {
      try { db.close(); } catch { /* already closed */ }
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
    },
  };
}

export function bigFunctionFixture(name = 'bigFn'): string {
  return `export function ${name}(input: number): number {\n${Array.from(
    { length: 90 },
    (_, index) => `  input += ${index}; // long body window ${index}`,
  ).join('\n')}\n  return input;\n}\n`;
}

export function smallFileFixture(fnName: string): string {
  return [
    `export function ${fnName}(a: number, b: number): number {`,
    '  const sum = a + b;',
    '  return sum * 2;',
    '}',
    '',
  ].join('\n');
}
