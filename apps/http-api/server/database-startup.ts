import { fork, type ForkOptions } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { isAbsolute } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { killProcessTree, trackProcessTree } from '@mcp/shared/utils/process-tree.js';

const require = createRequire(import.meta.url);
const pending = new Map<string, Promise<void>>();

/** Finish migrations off the main thread before lightweight stores can create
 * an empty SQLite header. Native startup runs in an owned process: terminating
 * a JS worker cannot interrupt a native SQLite call or native teardown. */
export function initializeDatabaseForStartup(dbPath: string): Promise<void> {
  if (!isAbsolute(dbPath)) return Promise.reject(new Error('database startup requires an absolute database path'));
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
  if (!compiled && !import.meta.url.endsWith('.ts')) throw new Error('database startup process is missing');
  const options: ForkOptions & { windowsHide: boolean } = {
    execArgv: compiled ? [] : ['--import', pathToFileURL(require.resolve('tsx')).href],
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    windowsHide: true, stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  };
  const child = fork(fileURLToPath(compiled ? built : source), [dbPath], options);
  const untrack = trackProcessTree(child.pid);
  const exited = new Promise<void>(resolve => child.once('close', () => { untrack(); resolve(); }));
  let stderr = '';
  child.stderr?.setEncoding('utf8');
  child.stderr?.on('data', text => { stderr = (stderr + text).slice(-4000); });
  let timer: ReturnType<typeof setTimeout> | undefined;
  let ready = false;
  try {
    await new Promise<void>((resolve, reject) => {
      child.on('message', message => {
        if (message === 'database-ready') { ready = true; resolve(); }
        else if (message && typeof message === 'object' && 'error' in message && typeof message.error === 'string') {
          reject(new Error(message.error));
        }
      });
      child.once('error', reject);
      child.once('close', code => reject(new Error(`database startup process exited before initialization (${code}). ${stderr}`)));
      timer = setTimeout(() => reject(new Error('database startup exceeded 180 seconds')), 180_000);
    });
  } finally {
    clearTimeout(timer);
    // Readiness is sent after database.close(); join normal native cleanup,
    // then forcibly retire only this owned process if it remains alive.
    let grace: ReturnType<typeof setTimeout> | undefined;
    const cleanExit = await Promise.race([
      exited.then(() => true),
      new Promise<false>(resolve => { grace = setTimeout(() => resolve(false), ready ? 1000 : 0); }),
    ]);
    clearTimeout(grace);
    if (!cleanExit) {
      await killProcessTree(child.pid);
      let cleanup: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([exited, new Promise<never>((_, reject) => {
          cleanup = setTimeout(() => reject(new Error('database startup process did not terminate')), 5000);
        })]);
      } finally { clearTimeout(cleanup); }
    }
  }
}