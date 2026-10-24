import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';

const pending = new Map<string, Promise<void>>();

/** Complete schema initialization before lightweight stores can create an
 * empty SQLite header. Migrations and startup maintenance run off main. */
export function initializeDatabaseForStartup(dbPath: string): Promise<void> {
  const active = pending.get(dbPath);
  if (active) return active;
  const operation = initialize(dbPath).finally(() => pending.delete(dbPath));
  pending.set(dbPath, operation);
  return operation;
}

async function initialize(dbPath: string): Promise<void> {
  const built = new URL('../workers/database-startup-worker.js', import.meta.url);
  const source = new URL('../workers/database-startup-worker.ts', import.meta.url);
  const compiled = existsSync(built);
  if (!compiled && !import.meta.url.endsWith('.ts')) throw new Error('database startup worker is missing');
  const worker = new Worker(compiled ? built : new URL('../workers/_dev-bootstrap.mjs', import.meta.url), {
    name: 'database-startup', execArgv: [],
    workerData: { dbPath, ...(compiled ? {} : { tsEntry: fileURLToPath(source) }) },
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await new Promise<void>((resolve, reject) => {
      let initialized = false;
      worker.on('message', message => { if (message === 'database-ready') initialized = true; });
      worker.once('error', reject);
      worker.once('exit', code => code === 0 && initialized ? resolve() : reject(new Error(`database startup worker exited before initialization (${code})`)));
      timer = setTimeout(() => reject(new Error('database startup exceeded 180 seconds')), 180_000);
    });
  } finally {
    clearTimeout(timer);
    await worker.terminate();
  }
}
