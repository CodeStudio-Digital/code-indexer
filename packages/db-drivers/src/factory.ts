/**
 * Driver factory — dispatch on engine. v1 ships PostgreSQL, MySQL/MariaDB and
 * SQLite (all three drivers are already root dependencies). Later engines
 * (mssql/mongodb/redis pure-JS; oracle lazy-installed) add a case here.
 */
import { createMongoDriver } from './mongodb.js';
import { createMssqlDriver } from './mssql.js';
import { createMysqlDriver } from './mysql.js';
import { createOracleDriver } from './oracle.js';
import { createPostgresDriver } from './postgres.js';
import { createRedisDriver } from './redis.js';
import { createSqliteProcessDriver } from './sqlite-process.js';
import { isWriteCommand } from './command-classify.js';
import { isReadStatement } from './sql/read-guard.js';
import { validateBatch } from './batch-outcome.js';
import type { DatabaseDriver, DbConnectConfig } from './types.js';
import { withDatabaseDeadline } from './dispatch.js';
import { createCatalogReader } from './catalog-reader.js';
import { withDatabaseTimings } from './query-timing.js';

export async function createDriver(config: DbConnectConfig): Promise<DatabaseDriver> {
  let driver: DatabaseDriver;
  switch (config.engine) {
    case 'postgres':
      driver = await createPostgresDriver(config);
      break;
    case 'mysql':
    case 'mariadb':
      driver = await createMysqlDriver(config);
      break;
    case 'sqlite':
      driver = await createSqliteProcessDriver(config);
      break;
    case 'mssql':
      driver = await createMssqlDriver(config);
      break;
    case 'oracle':
      driver = await createOracleDriver(config);
      break;
    case 'mongodb':
      driver = await createMongoDriver(config);
      break;
    case 'redis':
      driver = await createRedisDriver(config);
      break;
    default:
      throw new Error(`Unsupported database engine: ${String(config.engine)}`);
  }
  const guarded = config.readOnly ? protectReadOnly(driver) : driver;
  return {
    ...guarded,
    ...((guarded.kind ?? 'relational') === 'relational' ? { catalogPage: createCatalogReader(guarded, config.engine) } : {}),
    query: (sql, params) => withDatabaseTimings(() => withDatabaseDeadline({ params, timeoutMs: 30_000 }, effective => guarded.runQuery(sql, effective))),
    runQuery: (sql, opts = {}) => withDatabaseTimings(() => withDatabaseDeadline(opts, effective => guarded.runQuery(sql, effective))),
    ...(guarded.runBatch ? { runBatch: (statements: Parameters<NonNullable<DatabaseDriver['runBatch']>>[0], opts: import('./types.js').RunBatchOptions = {}) =>
      withDatabaseTimings(() => withDatabaseDeadline(opts, effective => guarded.runBatch!(statements, { ...opts, ...effective }))) } : {}),
    ...(guarded.runCommand ? { runCommand: (command: Parameters<NonNullable<DatabaseDriver['runCommand']>>[0], opts: import('./types.js').RunQueryOptions = {}) =>
      withDatabaseTimings(() => withDatabaseDeadline(opts, effective => guarded.runCommand!(command, effective))) } : {}),
  };
}

/**
 * Last enforcement boundary before engine code. UI and agent handlers guard
 * too, but keeping this at the factory means any future consumer of a saved
 * read-only connection inherits the same fail-closed behavior automatically.
 */
function protectReadOnly(driver: DatabaseDriver): DatabaseDriver {
  const deny = (): never => {
    throw new Error('Connection is read-only — writes are blocked.');
  };
  const protectedDriver: DatabaseDriver = {
    ...driver,
    async runQuery(sql, opts) {
      if (!isReadStatement(sql)) deny();
      return driver.runQuery(sql, opts);
    },
    async query(sql, params) {
      if (!isReadStatement(sql)) deny();
      return driver.query(sql, params);
    },
    ...(driver.runBatch
      ? {
          async runBatch(statements, opts) {
            validateBatch(statements, true);
            return driver.runBatch!(statements, opts);
          },
        }
      : {}),
    ...(driver.runCommand
      ? {
          async runCommand(command, opts) {
            if (isWriteCommand(command)) deny();
            return driver.runCommand!(command, opts);
          },
        }
      : {}),
  };
  return protectedDriver;
}
