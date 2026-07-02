/**
 * @mcp/db-drivers — engine-agnostic database driver layer for the embedded DB
 * client and the `db_*` agent tools. One implementation, two consumers.
 */
export * from './types.js';
export { createDriver } from './factory.js';
export { DbConnectionManager, sharedDbConnectionManager, type AcquireOptions, type ConnMeta } from './manager.js';
export { createPostgresDriver } from './postgres.js';
export { createMysqlDriver } from './mysql.js';
export { createSqliteDriver } from './sqlite.js';
export { quoteIdent, quoteRelation, placeholder, renderLiteral } from './sql/identifiers.js';
export { buildDml, type RowChange, type RowChangeKind, type BuiltDml } from './sql/dml.js';
export { insertLiteral } from './sql/dump.js';
export { buildDdl, buildSqliteRebuild, sqliteAlterNeedsRebuild } from './ddl/build.js';
export { isWriteCommand } from './command-classify.js';
export { stripSqlNoise, hasMultipleStatements, WRITE_KW, isReadStatement } from './sql/read-guard.js';
export {
  DB_DRIVER_REGISTRY, driverDefFor, driverInstallDir, isDriverInstalled, resolveDriverEntry,
  type DbDriverDef,
} from './driver-registry.js';
export type {
  ColumnSpec, CreateTableSpec, AlterAction, AlterTableSpec, DropTableSpec, DdlOp, DdlSpec,
} from './ddl/spec.js';
