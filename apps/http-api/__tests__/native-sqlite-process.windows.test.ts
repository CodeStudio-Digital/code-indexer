import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, it, vi } from 'vitest';
import { loadNativeHostBridge, parseRuntimePackageAnchor, verifyRuntimePackage, type NativeHostDuplexProcess } from '@mcp/agent-runtime-host';
import { createSqliteDriver } from '@mcp/db-drivers/sqlite.js';
import { NativeSqliteProcess } from '../workers/native-sqlite-process.js';

const physicalIt = process.platform === 'win32' && process.env.MCP_RUST_AGENT_PROCESS_REAL_E2E === '1' ? it : it.skip;
async function runtime() {
  return verifyRuntimePackage(resolve('dist/native-agent-runtime/x86_64-pc-windows-msvc'),
    parseRuntimePackageAnchor(await readFile('dist/apps/electron/native-agent-runtime-integrity.json')));
}
physicalIt('keeps the host responsive and physically cancels a CPU-bound SQLite aggregation', async () => {
  const binding = loadNativeHostBridge(await runtime());
  const directory = await mkdtemp(join(tmpdir(), 'native-sqlite-cancel-'));
  const controller = new AbortController(), unknown = vi.fn(); let pid = 0;
  const processOwner = new NativeSqliteProcess({ root: directory, deadline: Date.now() + 30000, signal: controller.signal,
    workerPath: resolve('dist/apps/http-api/workers/native-sqlite-worker.js'), assertOwner() {}, outcomeUnknown: unknown,
    spawn: input => { const owner = binding.startNativeHostDuplexProcess!(input); pid = owner.processId; return owner; } });
  const driver = await processOwner.initialize({ engine: 'sqlite', filePath: join(directory, 'fixture.sqlite') });
  try {
    await driver.runQuery('CREATE TABLE items (id INTEGER)');
    await driver.runQuery('INSERT INTO items VALUES (1)');
    const pending = driver.runQuery('WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<1000000000) SELECT sum(x) FROM n');
    const rejected = expect(pending).rejects.toThrow('exited');
    let cancelledAt = 0;
    const timer = setTimeout(() => { cancelledAt = performance.now(); controller.abort(); }, 50);
    await rejected; clearTimeout(timer); await processOwner.close();
    expect(cancelledAt).toBeGreaterThan(0); expect(performance.now() - cancelledAt).toBeLessThan(2500);
    expect(() => process.kill(pid, 0)).toThrow(); expect(unknown).not.toHaveBeenCalled();
    const reopened = createSqliteDriver({ engine: 'sqlite', filePath: join(directory, 'fixture.sqlite') });
    try { expect((await reopened.runQuery('SELECT * FROM items')).rows).toEqual([{ id: 1 }]); }
    finally { await reopened.close(); }
  } finally { controller.abort(); await processOwner.close(); }
}, 30000);

physicalIt('retains a committed write when its response is lost and leaves no process behind', async () => {
  const binding = loadNativeHostBridge(await runtime());
  const directory = await mkdtemp(join(tmpdir(), 'native-sqlite-ack-loss-'));
  const filePath = join(directory, 'fixture.sqlite');
  const controller = new AbortController(); let pid = 0;
  const processOwner = new NativeSqliteProcess({ root: directory, deadline: Date.now() + 30000, signal: controller.signal,
    workerPath: resolve('dist/apps/http-api/workers/native-sqlite-worker.js'), assertOwner() {}, outcomeUnknown() {},
    spawn: input => {
      const raw = binding.startNativeHostDuplexProcess!(input); pid = raw.processId;
      let buffer = '';
      // Only this test transport drops the reply after the real child committed.
      return { processId: raw.processId, write: raw.write.bind(raw), read: raw.read.bind(raw), cancel: raw.cancel.bind(raw), wait: raw.wait.bind(raw),
        readOutput: async () => {
          for (;;) {
            const part = await raw.readOutput!(); if (!part || part.stderr) return part;
            buffer += Buffer.from(part.bytes).toString('utf8');
            if (!buffer.includes('\n')) continue;
            const frame = JSON.parse(buffer.trim()); const output = Buffer.from(buffer); buffer = '';
            if (frame.id === 3) { raw.cancel(); return null; }
            return { bytes: output, stderr: false };
          }
        },
      } satisfies NativeHostDuplexProcess;
    } });
  try {
    const driver = await processOwner.initialize({ engine: 'sqlite', filePath });
    await driver.runQuery('CREATE TABLE items (id INTEGER)');
    await expect(driver.runQuery('INSERT INTO items VALUES (1)')).rejects.toThrow('exited');
    await processOwner.close(); expect(() => process.kill(pid, 0)).toThrow();
    const reopened = createSqliteDriver({ engine: 'sqlite', filePath });
    try { expect((await reopened.runQuery('SELECT count(*) AS n FROM items')).rows).toEqual([{ n: 1 }]); }
    finally { await reopened.close(); }
  } finally { controller.abort(); await processOwner.close(); }
}, 30000);
