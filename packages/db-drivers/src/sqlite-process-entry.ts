import { createSqliteDriver } from './sqlite.js';
import type { DatabaseDriver, DbConnectConfig } from './types.js';

let driver: DatabaseDriver | undefined;
const methods = new Set(['testConnection','listDatabases','listSchemas','listTables','describeTable','listIncomingForeignKeys','listObjects','tablePreview','schema','runQuery','query']);
process.on('message', async (message: unknown) => {
  const frame = message as { id: number; method: string; args: unknown[]; config?: DbConnectConfig };
  try {
    if (frame.method === 'open' && !driver) {
      driver = createSqliteDriver(frame.config!);
      process.send?.({ id: frame.id, result: true }); return;
    }
    if (!driver || !methods.has(frame.method)) throw new Error('Invalid SQLite process request');
    const fn = (driver as unknown as Record<string, (...args: unknown[]) => unknown>)[frame.method];
    const result = await fn(...frame.args);
    process.send?.({ id: frame.id, result });
  } catch (error) { process.send?.({ id: frame.id, error: error instanceof Error ? error.message : String(error) }); }
});
process.on('disconnect', () => { void driver?.close().finally(() => process.exit(0)); });
