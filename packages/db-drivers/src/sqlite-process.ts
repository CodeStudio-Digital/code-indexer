import { fork, type ChildProcess, type ForkOptions } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { trackProcessTree, killProcessTree } from '@mcp/shared/utils/process-tree.js';
import { BatchTracker, validateBatch } from './batch-outcome.js';
import { assertDatabaseDispatch } from './dispatch.js';
import { isReadStatement } from './sql/read-guard.js';
import { recordDatabaseStage, timedDatabaseStage } from './query-timing.js';
import type { DatabaseDriver, DbConnectConfig, QueryResult, RunBatchOptions, RunBatchStatement, RunQueryOptions } from './types.js';

const require = createRequire(import.meta.url);
export class SqliteExecutionError extends Error {
  readonly code = 'SQLITE_EXECUTOR_RETIRED';
  constructor(message: string, readonly effectOutcome?: 'unknown') { super(message); }
}

/** One owned process per SQLite connection. Killing it interrupts native SQL,
 * which cannot be cancelled by terminating a JS worker while native code runs. */
export async function createSqliteProcessDriver(config: DbConnectConfig): Promise<DatabaseDriver> {
  const source = import.meta.url.endsWith('.ts');
  const entry = fileURLToPath(new URL(source ? './sqlite-process-entry.ts' : './sqlite-process-entry.js', import.meta.url));
  const env: NodeJS.ProcessEnv = { ELECTRON_RUN_AS_NODE: '1' };
  for (const key of ['SystemRoot','WINDIR','TEMP','TMP']) if (process.env[key]) env[key] = process.env[key];
  const launchOptions: ForkOptions & { windowsHide: boolean } = { execArgv: source ? ['--import', pathToFileURL(require.resolve('tsx')).href] : [], env, windowsHide: true,
    stdio: ['ignore','ignore','pipe','ipc'], serialization: 'advanced' };
  const child: ChildProcess = fork(entry, [], launchOptions);
  const untrack = trackProcessTree(child.pid);
  let retired = false, id = 0, queueSize = 0, stderr = '';
  let tail: Promise<unknown> = Promise.resolve();
  let current: { id: number; resolve(value: unknown): void; reject(error: Error): void; mutating: boolean } | undefined;
  let stopped: Promise<void> | undefined;
  const exited = new Promise<void>(resolve => child.once('close', () => { untrack(); resolve(); }));
  child.stderr?.setEncoding('utf8');
  child.stderr?.on('data', text => { stderr = (stderr + text).slice(-2000); });
  child.on('message', raw => {
    const frame = raw as { id: number; result?: unknown; error?: string };
    if (!current || frame.id !== current.id) return;
    const pending = current; current = undefined;
    frame.error ? pending.reject(new Error(frame.error)) : pending.resolve(frame.result);
  });
  const lost = (message: string) => {
    retired = true;
    const pending = current; current = undefined;
    pending?.reject(new SqliteExecutionError(message, pending.mutating ? 'unknown' : undefined));
  };
  child.on('error', error => lost(error.message));
  child.on('close', code => lost(`SQLite executor exited (${code}). ${stderr}`));
  const stop = () => stopped ??= (async () => {
    retired = true;
    child.kill('SIGKILL');
    await killProcessTree(child.pid);
    await exited;
  })();

  async function rpc(method: string, args: unknown[], options: RunQueryOptions = {}, mutating = false, opening?: DbConnectConfig): Promise<unknown> {
    assertDatabaseDispatch(options);
    if (retired) throw new SqliteExecutionError('SQLite executor is retired. Reconnect before a new operation.');
    const requestId = ++id;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const abort = () => { lost('SQLite execution cancelled; reconnect before continuing.'); void stop(); };
    try {
      return await new Promise((resolve, reject) => {
        current = { id: requestId, resolve, reject, mutating };
        options.signal?.addEventListener('abort', abort, { once: true });
        timer = setTimeout(abort, Math.max(1, Math.min(options.timeoutMs ?? 30_000, options.deadlineAtEpochMs === undefined ? Infinity : options.deadlineAtEpochMs - Date.now(), 600_000)));
        timer.unref();
        if (options.signal?.aborted) { abort(); return; }
        child.send({ id: requestId, method, args, ...(opening ? { config: opening } : {}) }, error => { if (error) lost(error.message); });
      });
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', abort);
      if (retired) await stop();
    }
  }
  function serialized<T>(operation: () => Promise<T>, options: RunQueryOptions = {}): Promise<T> {
    assertDatabaseDispatch(options);
    if (queueSize >= 32) return Promise.reject(new Error('SQLite query queue is full'));
    queueSize++;
    const queuedAt = performance.now();
    let started = false;
    let rejectQueued: (reason?: unknown) => void = () => {};
    const cancelled = new Promise<never>((_resolve, reject) => { rejectQueued = reject; });
    const abortQueued = () => { if (!started) rejectQueued(options.signal?.reason ?? new Error('SQLite queued operation cancelled')); };
    options.signal?.addEventListener('abort', abortQueued, { once: true });
    if (options.signal?.aborted) abortQueued();
    const pending = tail.then(() => { assertDatabaseDispatch(options); started = true; recordDatabaseStage('queueMs', queuedAt); return operation(); })
      .finally(() => { queueSize--; });
    tail = pending.catch(() => undefined);
    return Promise.race([pending, cancelled]).finally(() => options.signal?.removeEventListener('abort', abortQueued));
  }
  const query = (sql: string, opts: RunQueryOptions = {}) => timedDatabaseStage('executeFetchMs', () => rpc('runQuery', [sql, { maxRows: opts.maxRows, schema: opts.schema, params: opts.params }], opts, !isReadStatement(sql)) as Promise<QueryResult>);
  try { await rpc('open', [], { timeoutMs: 10_000 }, false, config); }
  catch (error) { await stop(); throw error; }

  const driver = { kind: 'relational' as const,
    runQuery: (sql: string, opts: RunQueryOptions = {}) => serialized(() => query(sql, opts), opts),
    query: (sql: string, params?: unknown[]) => serialized(() => query(sql, { params })),
    runBatch: (statements: RunBatchStatement[], opts: RunBatchOptions = {}) => serialized(async () => {
      validateBatch(statements, config.readOnly);
      const tracker = new BatchTracker('transactional', opts);
      let last: QueryResult = { rows: [], fields: [], rowCount: 0 };
      try {
        tracker.dispatch(); await query('BEGIN', opts); tracker.started = true;
        for (let index = 0; index < statements.length; index++) {
          tracker.dispatch();
          const statement = statements[index];
          last = await query(typeof statement === 'string' ? statement : statement.sql,
            { ...opts, params: typeof statement === 'string' ? undefined : statement.params });
          opts.onResult?.(last, index); tracker.completed++;
        }
        tracker.dispatch(); tracker.committing = true; await query('COMMIT', opts);
        return { ...last, batchOutcome: tracker.success() };
      } catch (error) {
        let rolledBack = false;
        if (tracker.started && !retired) await query('ROLLBACK', {}).then(() => { rolledBack = true; }, () => undefined);
        throw tracker.failure(error, rolledBack);
      }
    }, opts),
    async close() { await tail; await stop(); },
  } as unknown as DatabaseDriver;
  for (const method of ['testConnection','listDatabases','listSchemas','listTables','describeTable','listIncomingForeignKeys','listObjects','tablePreview','schema']) {
    (driver as unknown as Record<string, unknown>)[method] = (...args: unknown[]) => serialized(() => rpc(method, args));
  }
  return driver;
}
