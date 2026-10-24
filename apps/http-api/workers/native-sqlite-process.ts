import { fileURLToPath } from 'node:url';
import { StringDecoder } from 'node:string_decoder';
import { setImmediate as yieldEventLoop } from 'node:timers/promises';
import type { NativeDuplexOptions, NativeHostDuplexProcess } from '@mcp/agent-runtime-host';
import type { DatabaseDriver, DbConnectConfig, RunQueryOptions } from '@mcp/db-drivers/types.js';
import { assertDatabaseDispatch, databaseDispatchSignal } from '@mcp/db-drivers/dispatch.js';
import { cleanProcessEnv } from '@mcp/code-agent/ports/shell-port.js';

const MAX_FRAME = 16 * 1024 * 1024;
interface Pending { resolve(value: unknown): void; reject(error: unknown): void }
interface Options {
  spawn(input: NativeDuplexOptions): NativeHostDuplexProcess;
  root: string;
  deadline: number;
  signal: AbortSignal;
  assertOwner(): void;
  outcomeUnknown(): void;
  executable?: string;
  workerPath?: string;
}

/** Keep synchronous SQLite work off the Coder worker's control/event loop.
 * Only a native Job wait receipt proves that a cancelled scan has stopped. */
export class NativeSqliteProcess {
  private readonly owner: NativeHostDuplexProcess;
  private readonly pending = new Map<number, Pending>();
  private readonly done: Promise<void>;
  private sequence = 0;
  private ended = false;
  private closing = false;
  private failure: unknown;
  private readonly cancel = () => this.owner.cancel();
  constructor(private readonly options: Options) {
    options.signal.throwIfAborted(); options.assertOwner(); assertDatabaseDispatch({});
    const remaining = options.deadline - Date.now();
    if (remaining <= 0) throw new Error('SQLite process authority expired');
    const environment = Object.fromEntries(Object.entries(cleanProcessEnv())
      .filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
    environment.ELECTRON_RUN_AS_NODE = '1';
    try {
      this.owner = options.spawn({ executable: options.executable ?? process.execPath,
        arguments: [options.workerPath ?? fileURLToPath(new URL('./native-sqlite-worker.js', import.meta.url))],
        cwd: options.root, environment, streamStderr: true, timeoutMs: Math.min(remaining, 86_400_000) });
    } catch (error) { options.outcomeUnknown(); throw error; }
    options.signal.addEventListener('abort', this.cancel, { once: true });
    this.done = this.observe();
    if (options.signal.aborted) this.cancel();
  }
  async initialize(config: DbConnectConfig): Promise<DatabaseDriver> {
    try { await this.call('init', [config]); }
    catch (error) { await this.close(); throw error; }
    const unsupported = async (): Promise<never> => { throw new Error('SQLite method is outside the admitted tool contract'); };
    return {
      kind: 'relational',
      testConnection: unsupported, listDatabases: unsupported, listSchemas: unsupported, listObjects: unsupported,
      tablePreview: unsupported, schema: unsupported, query: unsupported,
      listTables: schema => this.call('listTables', [schema]) as ReturnType<DatabaseDriver['listTables']>,
      describeTable: (schema, table) => this.call('describeTable', [schema, table]) as ReturnType<DatabaseDriver['describeTable']>,
      runQuery: (sql, options = {}) => this.call('runQuery', [sql, {
        params: options.params, maxRows: options.maxRows, timeoutMs: options.timeoutMs,
      }], options) as ReturnType<DatabaseDriver['runQuery']>,
      close: () => this.close(),
    };
  }
  private async call(method: string, args: unknown[], query: RunQueryOptions = {}): Promise<unknown> {
    if (this.closing || this.ended || this.pending.size >= 32) throw new Error('SQLite process is closed or saturated');
    this.options.assertOwner(); this.options.signal.throwIfAborted(); assertDatabaseDispatch(query);
    const inherited = databaseDispatchSignal(query.signal);
    const signal = AbortSignal.any([this.options.signal, ...(inherited ? [inherited] : []),
      AbortSignal.timeout(Math.max(1, Math.min(query.timeoutMs ?? 60_000, 600_000)))]);
    signal.throwIfAborted();
    const id = ++this.sequence, encoded = Buffer.from(JSON.stringify({ id, method, args }) + '\n');
    if (encoded.byteLength > MAX_FRAME) throw new Error('Database input exceeds 16 MiB');
    let receipt!: Pending;
    const result = new Promise((resolve, reject) => { receipt = { resolve, reject }; });
    void result.catch(() => undefined);
    this.pending.set(id, receipt);
    signal.addEventListener('abort', this.cancel, { once: true });
    try {
      signal.throwIfAborted(); this.options.assertOwner(); assertDatabaseDispatch(query);
      try { await this.owner.write(encoded).wait(); }
      catch (error) { this.owner.cancel(); await this.done; throw error; }
      return await result;
    } finally { signal.removeEventListener('abort', this.cancel); this.pending.delete(id); }
  }
  async close(): Promise<void> {
    this.closing = true; this.owner.cancel();
    await this.done;
    if (this.failure) throw new Error('Native SQLite process cleanup is unconfirmed');
  }
  private async observe(): Promise<void> {
    const drain = async () => {
      if (!this.owner.readOutput) throw new Error('SQLite requires tagged native output');
      const decoder = new StringDecoder('utf8');
      let fragments: string[] = [], size = 0, sinceYield = performance.now();
      for (;;) {
        const part = await this.owner.readOutput(); if (!part) break;
        if (part.stderr) continue; // diagnostics never become query data or expose secrets
        const segments = decoder.write(Buffer.from(part.bytes)).split('\n');
        for (let index = 0; index < segments.length; index++) {
          const segment = segments[index];
          size += Buffer.byteLength(segment);
          if (size > MAX_FRAME) throw new Error('SQLite response exceeds frame limit');
          if (segment) fragments.push(segment);
          if (index === segments.length - 1) break;
          const line = fragments.join(''); fragments = []; size = 0;
          const frame = JSON.parse(line) as { id: number; error?: string; result?: unknown };
          const receipt = this.pending.get(frame.id);
          if (!receipt) throw new Error('SQLite response has no matching request');
          this.pending.delete(frame.id);
          if (typeof frame.error === 'string') receipt.reject(new Error(frame.error)); else receipt.resolve(frame.result);
        }
        if (performance.now() - sinceYield >= 6) { await yieldEventLoop(); sinceYield = performance.now(); }
      }
      if (size || decoder.end()) throw new Error('SQLite process ended with an incomplete response');
    };
    const [read, exit] = await Promise.allSettled([
      drain().catch(error => { this.owner.cancel(); throw error; }), this.owner.wait(),
    ]);
    if (exit.status === 'rejected' || !exit.value.reaped || exit.value.processId !== this.owner.processId) {
      this.failure = new Error('Missing SQLite physical reap confirmation'); this.options.outcomeUnknown();
    }
    this.ended = true; this.options.signal.removeEventListener('abort', this.cancel);
    const error = read.status === 'rejected' ? read.reason : new Error('SQLite process exited before confirming the query');
    for (const receipt of this.pending.values()) receipt.reject(error);
    this.pending.clear();
  }
}
