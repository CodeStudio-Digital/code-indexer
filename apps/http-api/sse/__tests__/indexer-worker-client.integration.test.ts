import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CodeIndexDB } from '@mcp/store/db.js';
import { IndexerWorkerClient } from '../IndexerWorkerClient.js';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const ENV_KEYS = [
  'MCP_INDEX_WORKERS',
  'MCP_INDEX_POOL_MIN_BYTES',
  'MCP_INDEX_POOL_STRICT',
  'MCP_EXTRACT_CACHE',
  'MCP_PROJECT_DB',
] as const;
const previousEnv = new Map(ENV_KEYS.map((key) => [key, process.env[key]]));

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = previousEnv.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe('IndexerWorkerClient nested parser pool', () => {
  it('acknowledges exact deltas before indexing through the dedicated worker', async () => {
    process.env.MCP_INDEX_WORKERS = '2';
    process.env.MCP_INDEX_POOL_MIN_BYTES = '0';
    process.env.MCP_INDEX_POOL_STRICT = '1';
    process.env.MCP_EXTRACT_CACHE = '0';
    process.env.MCP_PROJECT_DB = '0';

    const dir = mkdtempSync(join(tmpdir(), 'mcp-indexer-worker-client-'));
    const root = join(dir, 'project');
    const dbPath = join(dir, 'index.db');
    mkdirSync(root);
    writeFileSync(join(root, 'alpha.ts'), 'export const alpha = 1;\n', 'utf8');
    writeFileSync(join(root, 'beta.ts'), 'export function beta() { return 2; }\n', 'utf8');

    const setupDb = new CodeIndexDB(dbPath);
    const project = setupDb.createProject('worker-client', root);
    setupDb.close();

    const client = new IndexerWorkerClient(
      { dbPath, concurrency: 2, idleTtlMs: 100 },
      {
        file: fileURLToPath(new URL('../../workers/_dev-bootstrap.mjs', import.meta.url)),
        execArgv: [],
        devTsEntry: fileURLToPath(new URL('../../workers/indexer-worker.ts', import.meta.url)),
        built: false,
      },
    );
    const changes: Array<{ path: string; kind: 'upsert' | 'delete' }> = [];
    const previousItemKeys: string[] = [];

    try {
      const result = await client.runStructuralIndex(project.id, {
        onChanges: (events, previousKeys) => {
          changes.push(...events);
          previousItemKeys.push(...previousKeys);
        },
      });
      expect(result).toMatchObject({ indexed: 2, errorCount: 0 });
      expect(result.phaseTimings?.parseMs).toBeTypeOf('number');
      expect(changes.sort((a, b) => a.path.localeCompare(b.path))).toEqual([
        { path: 'alpha.ts', kind: 'upsert' },
        { path: 'beta.ts', kind: 'upsert' },
      ]);
      expect(previousItemKeys).toEqual([]);

      // Manual repair must cross the worker RPC boundary even when source
      // hashes match the stored baseline; ordinary reopen remains cheap.
      await expect(client.runStructuralIndex(project.id, {})).resolves.toMatchObject({ indexed: 0, skipped: 2 });
      await expect(client.runStructuralIndex(project.id, { forceReparse: true }))
        .resolves.toMatchObject({ indexed: 2, skipped: 0, errorCount: 0 });

      writeFileSync(join(root, 'alpha.ts'), 'export const alphaRenamed = 2;\n', 'utf8');
      const pause = new AbortController();
      await expect(client.runStructuralIndex(project.id, {
        signal: pause.signal,
        onChanges: () => pause.abort(),
      })).resolves.toMatchObject({ aborted: 'signal', indexed: 0, removed: 0 });
      const incrementalChanges: Array<{ path: string; kind: 'upsert' | 'delete' }> = [];
      const incrementalPreviousKeys: string[] = [];
      await client.indexFiles(project.id, ['alpha.ts'], {
        onChanges: (events, previousKeys) => {
          incrementalChanges.push(...events);
          incrementalPreviousKeys.push(...previousKeys);
        },
      });
      expect(incrementalChanges).toEqual([{ path: 'alpha.ts', kind: 'upsert' }]);
      expect(incrementalPreviousKeys.some((key) => key.startsWith('file:'))).toBe(true);
      expect(incrementalPreviousKeys.some((key) => key.startsWith('symbol:'))).toBe(true);
      expect(incrementalPreviousKeys.some((key) => key.startsWith('symbol_body:'))).toBe(true);
      expect(incrementalPreviousKeys.some((key) => key.startsWith('symbol_group:'))).toBe(true);

      await client.dispose();
      const verifyDb = new CodeIndexDB(dbPath);
      try {
        expect(verifyDb.listFiles(project.id).map((file) => file.path).sort())
          .toEqual(['alpha.ts', 'beta.ts']);
      } finally {
        verifyDb.close();
      }
    } finally {
      await client.dispose().catch(() => undefined);
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);

  it('pauses an active structural request until foreground priority is released', async () => {
    process.env.MCP_INDEX_WORKERS = '0';
    process.env.MCP_EXTRACT_CACHE = '0';
    process.env.MCP_PROJECT_DB = '0';

    const dir = mkdtempSync(join(tmpdir(), 'mcp-indexer-worker-priority-'));
    const root = join(dir, 'project');
    const dbPath = join(dir, 'index.db');
    mkdirSync(root);
    writeFileSync(join(root, 'foreground.ts'), 'export const foreground = true;\n', 'utf8');

    const setupDb = new CodeIndexDB(dbPath);
    const project = setupDb.createProject('worker-priority', root);
    setupDb.close();
    const client = new IndexerWorkerClient(
      { dbPath, concurrency: 1, idleTtlMs: 100 },
      {
        file: fileURLToPath(new URL('../../workers/_dev-bootstrap.mjs', import.meta.url)),
        execArgv: [],
        devTsEntry: fileURLToPath(new URL('../../workers/indexer-worker.ts', import.meta.url)),
        built: false,
      },
    );

    try {
      client.setInteractivePriority(project.id, true);
      let settled = false;
      const run = client.runStructuralIndex(project.id, {})
        .finally(() => { settled = true; });

      let workerReady = false;
      for (let attempt = 0; attempt < 50; attempt++) {
        if (await client.memStats()) {
          workerReady = true;
          break;
        }
        await sleep(20);
      }
      expect(workerReady).toBe(true);
      await sleep(50);
      expect(settled).toBe(false);

      client.setInteractivePriority(project.id, false);
      await expect(run).resolves.toMatchObject({ indexed: 1, errorCount: 0 });
    } finally {
      client.setInteractivePriority(project.id, false);
      await client.dispose().catch(() => undefined);
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);
});
