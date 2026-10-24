import { createHash } from 'node:crypto';
import type { DbConnection } from '@mcp/store/db-client-store-types.js';
import type { DatabaseDriver } from '@mcp/db-drivers/types.js';
import { runDatabaseDispatch } from '@mcp/db-drivers/dispatch.js';
import { abortableRead } from '@mcp/shared/utils/abortable.js';
import type { DatabaseInvocation, DatabasePort } from '@mcp/code-agent/ports/database-port.js';
import type { DbToolsConnectionStore, DbSecretDecryptor } from '@mcp/code-agent/tools/db/store-binding.js';
import { resolveConnConfig, scrubDbError, type ResolvedDbSpec } from '@mcp/code-agent/tools/db/resolve-spec.js';
import type { AcquiredDb } from '@mcp/code-agent/tools/db/pool.js';
import type { HostEffectScope } from '@mcp/code-agent/runtime/host-effect-scope.js';

/** Cosmetic/last-used updates cannot silently replace an admitted DB target. */
export function databaseConnectionRevision(row: DbConnection): string {
  const { id, project_id, label, engine, host, port, username, database_name, file_path,
    enc_password, ssl_mode, enc_ssl_ca, enc_ssl_cert, enc_ssl_key, ssh_tunnel_host_id,
    ssh_tunnel_json, options_json, is_read_only } = row;
  return createHash('sha256').update(JSON.stringify({ id, project_id, label, engine, host, port, username,
    database_name, file_path, enc_password, ssl_mode, enc_ssl_ca, enc_ssl_cert, enc_ssl_key,
    ssh_tunnel_host_id, ssh_tunnel_json, options_json, is_read_only })).digest('hex');
}

interface Options {
  projectId: number;
  store: DbToolsConnectionStore;
  signal: AbortSignal;
  assertOwner(): void;
  decrypt: DbSecretDecryptor;
  effects: HostEffectScope;
  outcomeUnknown(): void;
  createDriver?: (config: ResolvedDbSpec['config']) => Promise<DatabaseDriver>;
}

/** Drivers are attempt-owned; cancellation never drops an unconfirmed physical
 * operation from HostEffectScope or borrows the UI's connection pool. */
export class NativeDatabasePort implements DatabasePort {
  private readonly rows: ReadonlyArray<DbConnection>;
  private readonly openings = new Map<number, Promise<AcquiredDb>>();
  private readonly owned = new Map<number, AcquiredDb>();
  private readonly controller = new AbortController();
  private readonly signal: AbortSignal;
  private closing?: Promise<void>;
  constructor(private readonly options: Options) {
    options.assertOwner(); options.signal.throwIfAborted();
    this.rows = options.store.listConnections(options.projectId).map(row => Object.freeze({ ...row }));
    this.signal = AbortSignal.any([options.signal, this.controller.signal]);
  }
  outcomeUnknown(): void { this.options.outcomeUnknown(); }
  listConnections(projectId: number): DbConnection[] {
    this.assertLifetime();
    if (projectId !== this.options.projectId) throw new Error('Database belongs to another project');
    return this.rows.map(row => ({ ...row }));
  }
  private assertLifetime(): void { this.signal.throwIfAborted(); this.options.assertOwner(); }
  private assertConnection(row: DbConnection): void {
    this.assertLifetime();
    const accepted = this.rows.find(item => item.id === row.id);
    const current = this.options.store.listConnections(this.options.projectId).find(item => item.id === row.id);
    if (row.project_id !== this.options.projectId || !accepted || !current
      || databaseConnectionRevision(accepted) !== databaseConnectionRevision(row)
      || databaseConnectionRevision(accepted) !== databaseConnectionRevision(current)) {
      throw new Error('Database connection changed after attempt admission; start a new attempt');
    }
  }
  async acquire(row: DbConnection, invocation: DatabaseInvocation): Promise<AcquiredDb> {
    this.assertConnection(row); invocation.signal?.throwIfAborted(); invocation.assertDispatch();
    let pending = this.openings.get(row.id);
    if (!pending) {
      pending = this.options.effects.track(() => this.open(row, invocation));
      this.openings.set(row.id, pending);
      void pending.catch(() => {
        if (!this.owned.has(row.id) && this.openings.get(row.id) === pending) this.openings.delete(row.id);
      });
    }
    const acquired = await pending;
    this.assertConnection(row); invocation.assertDispatch(); invocation.signal?.throwIfAborted();
    const signal = AbortSignal.any([this.signal, ...(invocation.signal ? [invocation.signal] : [])]);
    const assertDispatch = () => { this.assertLifetime(); invocation.assertDispatch(); signal.throwIfAborted(); };
    const allowed = new Set(['listTables', 'describeTable', 'runQuery', 'runCommand']);
    const driver = new Proxy(acquired.driver, {
      get: (target, name, receiver) => {
        const value = Reflect.get(target, name, receiver);
        if (typeof value !== 'function') return value;
        return (...args: unknown[]) => {
          if (!allowed.has(String(name))) return Promise.reject(new Error('Database operation is outside the admitted tool contract'));
          return this.options.effects.track(() => runDatabaseDispatch({ signal, assertDispatch }, async () => {
            this.assertConnection(row); assertDispatch();
            try { return await value.apply(target, args); }
            catch (error) { throw new Error(scrubDbError(error, acquired.spec)); }
          }));
        };
      },
    });
    return { ...acquired, driver };
  }
  private async open(row: DbConnection, invocation: DatabaseInvocation): Promise<AcquiredDb> {
    let spec: ResolvedDbSpec | undefined;
    const assertDispatch = () => {
      this.assertConnection(row); invocation.signal?.throwIfAborted(); invocation.assertDispatch();
    };
    try {
      assertDispatch();
      spec = await resolveConnConfig(row, async blob => {
        assertDispatch(); const secret = await this.options.decrypt(blob); assertDispatch(); return secret;
      });
      const factory = this.options.createDriver ?? (await import('@mcp/db-drivers/factory.js')).createDriver;
      assertDispatch();
      const signal = AbortSignal.any([this.signal, ...(invocation.signal ? [invocation.signal] : [])]);
      const driver = await runDatabaseDispatch({ signal, assertDispatch }, () => factory(spec!.config));
      const acquired: AcquiredDb = { driver, key: `attempt-db:${row.id}`, spec,
        meta: { engine: row.engine, readOnly: row.is_read_only === 1, kind: driver.kind ?? 'relational' } };
      this.owned.set(row.id, acquired);
      // A late connection is owned before checking cancellation and remains so
      // until its close is confirmed by the attempt's drain.
      assertDispatch();
      return acquired;
    } catch (error) { throw new Error(scrubDbError(error, spec)); }
  }
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.controller.abort(new Error('Native database scope closed'));
    const cleanup = (async () => {
      await Promise.allSettled([...this.openings.values()]);
      const results = await Promise.allSettled([...this.owned.entries()].map(async ([id, acquired]) => {
        await acquired.driver.close(); this.owned.delete(id);
      }));
      const errors = results.filter(result => result.status === 'rejected').map(result => result.reason);
      if (errors.length) throw new Error('Native database cleanup is unconfirmed');
    })();
    void cleanup.catch(() => undefined);
    this.closing = abortableRead(() => cleanup, AbortSignal.timeout(10_000));
    return this.closing;
  }
}
