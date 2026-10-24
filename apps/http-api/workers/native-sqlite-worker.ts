import { createInterface } from 'node:readline';
import { createSqliteDriver } from '@mcp/db-drivers/sqlite.js';
import type { DatabaseDriver, DbConnectConfig, RunQueryOptions } from '@mcp/db-drivers/types.js';

// This helper runs only inside an attempt-owned native Job, never Electron main.
// The parent is the authority boundary and can physically terminate a long scan.
const MAX_FRAME = 16 * 1024 * 1024;
let driver: DatabaseDriver | undefined;
async function reply(id: number, value: Record<string, unknown>) {
  let line = JSON.stringify({ id, ...value });
  if (Buffer.byteLength(line) > MAX_FRAME) line = JSON.stringify({ id, error: 'Database output exceeds 16 MiB; reduce the query result.' });
  await new Promise<void>((resolve, reject) => process.stdout.write(line + '\n', error => error ? reject(error) : resolve()));
}
async function main() {
  const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of input) {
    if (Buffer.byteLength(line) > MAX_FRAME) throw new Error('Database input exceeds frame limit');
    const request = JSON.parse(line) as { id: number; method: string; args: unknown[] };
    if (!Number.isSafeInteger(request.id) || !Array.isArray(request.args)) throw new Error('Invalid database frame');
    try {
      let result: unknown;
      if (request.method === 'init') {
        if (driver) throw new Error('Database already initialized');
        const config = request.args[0] as DbConnectConfig;
        if (config.engine !== 'sqlite') throw new Error('This helper owns SQLite only');
        driver = createSqliteDriver(config); result = null;
      } else {
        if (!driver) throw new Error('Database is not initialized');
        if (request.method === 'runQuery') result = await driver.runQuery(String(request.args[0]), request.args[1] as RunQueryOptions);
        else if (request.method === 'listTables') result = await driver.listTables(request.args[0] as string | undefined);
        else if (request.method === 'describeTable') result = await driver.describeTable(String(request.args[0]), String(request.args[1]));
        else throw new Error('Database method is not admitted');
      }
      await reply(request.id, { result });
    } catch (error) { await reply(request.id, { error: error instanceof Error ? error.message : String(error) }); }
  }
}
void main().catch(() => { process.exitCode = 1; }).finally(async () => { await driver?.close(); });
