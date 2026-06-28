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
import { createSqliteDriver } from './sqlite.js';
import type { DatabaseDriver, DbConnectConfig } from './types.js';

export async function createDriver(config: DbConnectConfig): Promise<DatabaseDriver> {
  switch (config.engine) {
    case 'postgres':
      return createPostgresDriver(config);
    case 'mysql':
    case 'mariadb':
      return createMysqlDriver(config);
    case 'sqlite':
      return createSqliteDriver(config);
    case 'mssql':
      return createMssqlDriver(config);
    case 'oracle':
      return createOracleDriver(config);
    case 'mongodb':
      return createMongoDriver(config);
    case 'redis':
      return createRedisDriver(config);
    default:
      throw new Error(`Unsupported database engine: ${String(config.engine)}`);
  }
}
