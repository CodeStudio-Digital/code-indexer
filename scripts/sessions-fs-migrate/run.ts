import {
  appendFileSync,
  existsSync,
  readdirSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { parseCliArgs } from './cli.js';
import {
  assertDatabaseIntegrity,
  checkpointWal,
  openDatabase,
  tableColumns,
  tableExists,
} from './db.js';
import {
  assertElectronAbi,
  assertOffline,
  assertSessionStorageRootAvailable,
  assertSpace,
  assertWritableDirectory,
  ensureSafeSessionStoragePath,
  findBlockingProcesses,
  listProcesses,
  acquireMaintenanceLock,
} from './guards.js';
import { inventoryProjects, inventorySource } from './inventory.js';
import {
  buildBundlePlans,
  collectBundleTemporaryFiles,
  commitStagingBundle,
  discoverBundleDirs,
  MissingProjectCatalogEntryError,
  prepareStagingBundle,
  promoteInterruptedFinalBundle,
  resetStagingBundle,
} from './bundles.js';
import { UuidRegistry } from './uuid-map.js';
import { buildRelationalExportIndex } from './relational.js';
import { findMissingProjectCatalogEvidence } from './catalog-diagnostics.js';
import { createElectronSecretSealer } from './secrets.js';
import { exportBundle } from './exporter.js';
import {
  aggregateBundleCounts,
  assertCleanDatabase,
  assertExportCounts,
  assertPostCutWriteGuards,
  smokeOperationalBundleRepositories,
  verifyBundle,
} from './verify.js';
import {
  captureEssentialDigest,
  createCleanClone,
  databaseSwapBackupPath,
  smokeCodeIndexDatabase,
  swapCleanDatabase,
} from './cleaner.js';
import { cleanupLegacySessionSideStores } from './legacy-cleanup.js';
import {
  auditProjectDatabases,
  discoverProjectDatabases,
  prepareCleanProjectDatabases,
  smokeCleanProjectDatabase,
  verifyProjectDatabasesClean,
} from './project-databases.js';
import {
  assertNoInterruptedDatabaseSwap,
  commitSwapJournal,
  discardSwapJournal,
  recoverInterruptedDatabaseSwap,
  writeSwapJournal,
  type DatabaseSwapJournal,
} from './swap-journal.js';
import {
  atomicWriteJson,
  readJsonFile,
} from './fs-ops.js';
import {
  findUnclassifiedSessionSchema,
  TABLE_DISPOSITIONS,
} from './manifest.js';
import type {
  BundlePlan,
  CliOptions,
  Logger,
  MigrationFile,
  MigrationRunState,
  ProjectRow,
  SourceInventory,
  SqliteDatabase,
} from './model.js';
import {
  MIGRATION_FORMAT_VERSION,
  SESSION_LAYOUT_VERSION,
} from './model.js';

interface ResolvedPaths {
  dataDir: string;
  dbPath: string;
}

interface MigrationSummary {
  mode: CliOptions['mode'];
  db_path: string;
  data_dir: string;
  source_fingerprint?: string;
  bundles?: number;
  sessions?: Record<string, number>;
  scopes?: Record<string, number>;
  table_rows?: Record<string, number>;
  blockers?: Array<{ pid: number; name: string }>;
  process_audit_error?: string;
  verified_bundles?: number;
  project_databases?: number;
  project_database_session_rows?: Record<string, number>;
  cleanup?: {
    removed_files: number;
    removed_directories: number;
    skipped: string[];
  };
  legacy_orphan_cleanup?: Record<string, import('./model.js').LegacyOrphanCleanupAudit>;
}

function resolvePaths(options: CliOptions): ResolvedPaths {
  const dataDir = resolve(
    options.dataDir
      ?? process.env.MCP_DATA_DIR?.trim()
      ?? join(homedir(), '.mcp-code-indexer'),
  );
  const dbPath = resolve(
    options.dbPath
      ?? process.env.MCP_INDEX_DB?.trim()
      ?? join(dataDir, 'index.db'),
  );
  return { dataDir, dbPath };
}

function createLogger(json: boolean): Logger {
  const write = (
    level: 'info' | 'warn',
    message: string,
    fields: Record<string, unknown> = {},
  ): void => {
    if (json) {
      emitOutput(process.stderr, `${JSON.stringify({
        timestamp: new Date().toISOString(),
        level,
        message,
        ...fields,
      })}\n`);
      return;
    }
    const suffix = Object.keys(fields).length > 0 ? ` ${JSON.stringify(fields)}` : '';
    emitOutput(
      process.stderr,
      `[sessions-fs-migrate] ${level.toUpperCase()} ${message}${suffix}\n`,
    );
  };
  return {
    info: (message, fields) => write('info', message, fields),
    warn: (message, fields) => write('warn', message, fields),
  };
}

function emitOutput(stream: NodeJS.WriteStream, content: string): void {
  const phaseLog = process.env.MCP_SESSIONS_MIGRATE_PHASE_LOG?.trim();
  if (phaseLog) {
    appendFileSync(phaseLog, content, 'utf8');
    return;
  }
  stream.write(content);
}

function outputSummary(summary: MigrationSummary, json: boolean): void {
  if (json) {
    emitOutput(process.stdout, `${JSON.stringify(summary, null, 2)}\n`);
    return;
  }
  emitOutput(
    process.stdout,
    `[sessions-fs-migrate] ${summary.mode} complete: ${JSON.stringify(summary)}\n`,
  );
}

function readLayoutMarker(db: SqliteDatabase): string | null {
  if (!tableExists(db, 'app_settings')) return null;
  const row = db.prepare(
    `SELECT value FROM app_settings WHERE key = 'session_storage_layout_version'`,
  ).get() as { value?: unknown } | undefined;
  return typeof row?.value === 'string' ? row.value : null;
}

function sourceSchema(db: SqliteDatabase): Array<{ name: string; columns: string[] }> {
  return (db.prepare(
    `SELECT name FROM sqlite_master
     WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
     ORDER BY name`,
  ).all() as Array<{ name: string }>).map((row) => ({
    name: row.name,
    columns: tableColumns(db, row.name),
  }));
}

function assertSourceManifestCoverage(db: SqliteDatabase): void {
  const violations = findUnclassifiedSessionSchema(sourceSchema(db));
  if (violations.length > 0) {
    throw new Error(`source schema has no explicit disposition:\n${violations.join('\n')}`);
  }
}

function rootsForPlans(
  plans: readonly BundlePlan[],
  dataDir: string,
): string[] {
  return [...new Set([
    resolve(dataDir),
    ...plans.flatMap((plan) => plan.projectRoot ? [resolve(plan.projectRoot)] : []),
  ])].sort();
}

function validateSessionRootChains(
  plans: readonly BundlePlan[],
  dataDir: string,
  create: boolean,
): void {
  const seen = new Set<string>();
  for (const plan of plans) {
    const owner = resolve(plan.projectRoot ?? dataDir);
    const sessionRoot = resolve(dirname(plan.finalDir));
    const key = process.platform === 'win32'
      ? `${owner.toLowerCase()}\0${sessionRoot.toLowerCase()}`
      : `${owner}\0${sessionRoot}`;
    if (seen.has(key)) continue;
    seen.add(key);
    ensureSafeSessionStoragePath(owner, sessionRoot, create);
  }
}

function validateSessionRootWriteAccess(
  plans: readonly BundlePlan[],
  dataDir: string,
): void {
  const seen = new Set<string>();
  for (const plan of plans) {
    const owner = resolve(plan.projectRoot ?? dataDir);
    const sessionRoot = resolve(dirname(plan.finalDir));
    const key = process.platform === 'win32'
      ? sessionRoot.toLowerCase()
      : sessionRoot;
    if (seen.has(key)) continue;
    seen.add(key);

    // Probe the deepest existing trusted component. This accurately catches a
    // project that cannot create `.mcp-indexer`, while allowing a protected
    // project root whose pre-created `.mcp-indexer/session` grants the user
    // write access.
    const probeRoot = [sessionRoot, dirname(sessionRoot), owner]
      .find((candidate) => existsSync(candidate));
    if (!probeRoot) {
      throw new Error(`no existing owner component for session root ${sessionRoot}`);
    }
    assertSessionStorageRootAvailable(probeRoot, true);
  }
}

function validateRootsAndSpace(
  roots: readonly string[],
  dbPath: string,
  inventory: SourceInventory,
  writeProbe: boolean,
): void {
  for (const root of roots) {
    assertSessionStorageRootAvailable(root, writeProbe);
  }
  assertSessionStorageRootAvailable(dirname(dbPath), writeProbe);
  assertSpace(dirname(dbPath), inventory.requiredBytes);
  const dbDrive = resolve(dirname(dbPath)).slice(0, 3).toLowerCase();
  for (const root of roots) {
    if (resolve(root).slice(0, 3).toLowerCase() === dbDrive) continue;
    assertSpace(root, Math.min(inventory.requiredBytes, 512 * 1024 * 1024));
  }
}

function summarizePlans(plans: readonly BundlePlan[]): {
  sessions: Record<string, number>;
  scopes: Record<string, number>;
} {
  const sessions: Record<string, number> = {};
  const scopes: Record<string, number> = {};
  for (const plan of plans) {
    sessions[plan.identity.kind] = (sessions[plan.identity.kind] ?? 0) + 1;
    scopes[plan.scope] = (scopes[plan.scope] ?? 0) + 1;
  }
  return { sessions, scopes };
}

function aggregateProjectDatabaseRows(
  audits: readonly { sessionRows: Readonly<Record<string, number>> }[],
): Record<string, number> {
  const rows: Record<string, number> = {};
  for (const audit of audits) {
    for (const [table, count] of Object.entries(audit.sessionRows)) {
      rows[table] = (rows[table] ?? 0) + count;
    }
  }
  return rows;
}

function buildPlansFailClosed(
  db: SqliteDatabase,
  dataDir: string,
  projects: readonly ProjectRow[],
  registry: UuidRegistry,
  logger: Logger,
): BundlePlan[] {
  try {
    return buildBundlePlans(db, dataDir, projects, registry);
  } catch (error) {
    if (!(error instanceof MissingProjectCatalogEntryError)) throw error;
    const evidence = findMissingProjectCatalogEvidence(dataDir, error.projectId);
    const requiredAction = `re-register project ${error.projectId} before cut`;
    const requiredActionPt = `re-registrar projeto ${error.projectId} antes do corte`;
    logger.warn('project catalog gap blocks filesystem-session migration', {
      project_id: error.projectId,
      owner: error.ownerLabel,
      required_action: requiredAction,
      required_action_pt: requiredActionPt,
      read_only_evidence: evidence,
    });
    const evidenceText = evidence.length > 0
      ? JSON.stringify(evidence)
      : 'no matching local project DB was found';
    throw new Error(
      `${error.message}; mandatory action: ${requiredAction} (${requiredActionPt}); read-only evidence=${evidenceText}`,
      { cause: error },
    );
  }
}

function expectedExportCounts(
  inventory: SourceInventory,
  orphanCleanup: Readonly<Record<string, import('./model.js').LegacyOrphanCleanupAudit>> = {},
): Record<string, number> {
  const retiredFeatureTables = new Set(
    TABLE_DISPOSITIONS
      .filter((item) => item.kind === 'drop' && (item.exportOwner === 'sprite' || item.exportOwner === 'design'))
      .map((item) => item.table),
  );
  return Object.fromEntries(
    Object.entries(inventory.tables)
      .filter(([table]) => !retiredFeatureTables.has(table))
      .map(([table, value]) => {
      const orphanRows = orphanCleanup[table]?.rows ?? 0;
      if (orphanRows > value.rows) {
        throw new Error(
          `legacy orphan cleanup exceeds source inventory for ${table}: orphan=${orphanRows}, source=${value.rows}`,
        );
      }
      return [table, value.rows - orphanRows];
      }),
  );
}

function createOrResumeState(
  statePath: string,
  inventory: SourceInventory,
  roots: readonly string[],
  orphanCleanup: Record<string, import('./model.js').LegacyOrphanCleanupAudit>,
): MigrationRunState {
  const expected = expectedExportCounts(inventory, orphanCleanup);
  if (existsSync(statePath)) {
    const state = readJsonFile<MigrationRunState>(statePath);
    if (
      state.format_version !== MIGRATION_FORMAT_VERSION
      || state.source_db_fingerprint !== inventory.dbFingerprint
      || resolve(state.source_db_path) !== resolve(inventory.dbPath)
    ) {
      throw new Error(`migration state belongs to another source DB: ${statePath}`);
    }
    if (JSON.stringify(state.expected_counts) !== JSON.stringify(expected)) {
      throw new Error('source row counts changed since the resumable migration was inventoried');
    }
    if (JSON.stringify(state.legacy_orphan_cleanup) !== JSON.stringify(orphanCleanup)) {
      throw new Error('legacy orphan cleanup audit changed since migration inventory');
    }
    return state;
  }
  const now = new Date().toISOString();
  const state: MigrationRunState = {
    format_version: MIGRATION_FORMAT_VERSION,
    source_db_path: inventory.dbPath,
    source_db_fingerprint: inventory.dbFingerprint,
    source_db_bytes: inventory.dbBytes,
    phase: 'inventoried',
    started_at: now,
    updated_at: now,
    expected_counts: expected,
    exported_counts: {},
    legacy_orphan_cleanup: orphanCleanup,
    roots: [...roots],
  };
  atomicWriteJson(statePath, state);
  return state;
}

function persistState(
  path: string,
  state: MigrationRunState,
  phase?: MigrationRunState['phase'],
): void {
  if (phase) state.phase = phase;
  state.updated_at = new Date().toISOString();
  atomicWriteJson(path, state);
}

function markerAt(path: string): MigrationFile | null {
  const markerPath = join(path, 'migration.json');
  return existsSync(markerPath) ? readJsonFile<MigrationFile>(markerPath) : null;
}

async function ensureBundleExported(
  db: SqliteDatabase,
  dataDir: string,
  inventory: SourceInventory,
  projects: readonly ProjectRow[],
  plan: BundlePlan,
  relational: ReturnType<typeof buildRelationalExportIndex>,
  sealer: Awaited<ReturnType<typeof createElectronSecretSealer>>,
  logger: Logger,
  runState: MigrationRunState,
): Promise<void> {
  if (existsSync(plan.finalDir)) {
    const marker = markerAt(plan.finalDir);
    if (marker?.phase === 'staging') {
      collectBundleTemporaryFiles(plan.finalDir);
      verifyBundle(plan.finalDir, plan.uuid, inventory.dbFingerprint, 'staging');
      promoteInterruptedFinalBundle(plan, inventory.dbFingerprint);
      logger.info('recovered bundle interrupted after atomic directory rename', {
        uuid: plan.uuid,
      });
    }
    prepareStagingBundle(plan, inventory.dbFingerprint);
    verifyBundle(plan.finalDir, plan.uuid, inventory.dbFingerprint, 'committed');
    return;
  }

  if (existsSync(plan.stagingDir)) {
    try {
      collectBundleTemporaryFiles(plan.stagingDir);
      verifyBundle(plan.stagingDir, plan.uuid, inventory.dbFingerprint, 'staging');
      logger.info('verified completed staging bundle; resume skips re-export', {
        uuid: plan.uuid,
      });
      return;
    } catch (error) {
      logger.warn('discarding incomplete staging bundle before deterministic re-export', {
        uuid: plan.uuid,
        reason: error instanceof Error ? error.message : String(error),
      });
      resetStagingBundle(plan);
    }
  }

  prepareStagingBundle(plan, inventory.dbFingerprint);
  await exportBundle({
    db,
    dataDir,
    sourceFingerprint: inventory.dbFingerprint,
    projects,
    relational,
    sealer,
    logger,
    runState,
  }, plan);
  verifyBundle(plan.stagingDir, plan.uuid, inventory.dbFingerprint, 'staging');
}

export function verifyDiscoveredBundles(
  db: SqliteDatabase,
  dataDir: string,
): number {
  const projectColumns = new Set(tableColumns(db, 'projects'));
  const projectFilter = projectColumns.has('is_synthetic')
    ? 'WHERE COALESCE(is_synthetic, 0) = 0'
    : '';
  const projects = (db.prepare(
    `SELECT id, root_path FROM projects
     ${projectFilter}
     ORDER BY id`,
  ).all() as ProjectRow[])
    .filter((project) => (
      typeof project.root_path === 'string'
      && project.root_path.trim().length > 0
    ));
  assertSessionStorageRootAvailable(dataDir, false);
  ensureSafeSessionStoragePath(
    dataDir,
    join(dataDir, 'sessions', 'global'),
    false,
  );
  for (const project of projects) {
    assertSessionStorageRootAvailable(project.root_path, false);
    ensureSafeSessionStoragePath(
      project.root_path,
      join(project.root_path, '.mcp-indexer', 'session'),
      false,
    );
  }
  const catalogRoots = [
    join(dataDir, 'sessions', 'global'),
    ...projects.map((project) => join(project.root_path, '.mcp-indexer', 'session')),
  ];
  let verified = 0;
  const uniqueRoots = [...new Set(catalogRoots.map((path) => resolve(path)))];
  for (const root of uniqueRoots) {
    if (!existsSync(root)) continue;
    const incomplete = readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name.startsWith('.migrating-'))
      .map((entry) => entry.name);
    if (incomplete.length > 0) {
      throw new Error(`incomplete bundle staging remains at ${root}: ${incomplete.join(', ')}`);
    }
  }
  for (const root of uniqueRoots) {
    if (!existsSync(root)) continue;
    for (const bundle of discoverBundleDirs(root)) {
      verifyBundle(bundle, basename(bundle), undefined, 'committed');
      verified += 1;
    }
  }
  return verified;
}

async function dryRun(
  paths: ResolvedPaths,
  options: CliOptions,
  logger: Logger,
): Promise<MigrationSummary> {
  assertNoInterruptedDatabaseSwap(dirname(paths.dbPath), paths.dbPath);
  logger.info('dry-run opening SQLite in strict read-only mode');
  const db = openDatabase(paths.dbPath, { readonly: true, fileMustExist: true });
  try {
    logger.info('dry-run running integrity_check and foreign_key_check');
    assertDatabaseIntegrity(db);
    logger.info('dry-run SQLite integrity checks passed');
    assertSourceManifestCoverage(db);
    logger.info('dry-run source schema is fully classified by the disposition manifest');
    const marker = readLayoutMarker(db);
    if (marker === String(SESSION_LAYOUT_VERSION)) {
      throw new Error('database is already filesystem-session layout; use --verify-only');
    }
    if (marker != null) throw new Error(`unsupported session layout marker: ${marker}`);
    logger.info('dry-run inventorying session rows and hashing the source DB');
    const inventory = inventorySource(db, paths.dbPath);
    logger.info('dry-run source inventory complete', {
      fingerprint: inventory.dbFingerprint,
      db_bytes: inventory.dbBytes,
    });
    const registry = new UuidRegistry(null, inventory.dbFingerprint);
    const plans = buildPlansFailClosed(
      db,
      paths.dataDir,
      inventory.projects,
      registry,
      logger,
    );
    validateSessionRootChains(plans, paths.dataDir, false);
    validateSessionRootWriteAccess(plans, paths.dataDir);
    logger.info('dry-run resolving every session-scoped row to exactly one bundle', {
      bundles: plans.length,
    });
    const relational = buildRelationalExportIndex(db, plans, registry);
    logger.info('dry-run relational ownership verification passed');
    const projectDatabases = discoverProjectDatabases(
      inventory.projects,
      paths.dataDir,
      paths.dbPath,
    );
    const projectDatabaseAudits = auditProjectDatabases(
      db,
      projectDatabases,
      { checkpoint: false },
    );
    for (const audit of projectDatabaseAudits) {
      // Windows accessSync(W_OK) does not prove effective create permission.
      // A same-directory probe is created, fsynced and removed immediately.
      assertSessionStorageRootAvailable(dirname(audit.path), true);
      assertSpace(
        dirname(audit.path),
        Math.ceil(audit.sourceBytes * 2.25 + 64 * 1024 * 1024),
      );
    }
    logger.info('dry-run project SQLite audit passed', {
      databases: projectDatabaseAudits.length,
      session_rows: aggregateProjectDatabaseRows(projectDatabaseAudits),
    });
    const roots = rootsForPlans(plans, paths.dataDir);
    validateRootsAndSpace(roots, paths.dbPath, inventory, false);
    let blockers: ReturnType<typeof findBlockingProcesses> = [];
    let processAuditError: string | undefined;
    try {
      blockers = findBlockingProcesses(listProcesses());
    } catch (error) {
      processAuditError = error instanceof Error ? error.message : String(error);
      logger.warn('could not enumerate every runtime process during dry-run', {
        reason: processAuditError,
      });
    }
    if (blockers.length > 0) {
      logger.warn('apply would be refused until active runtime processes are stopped', {
        count: blockers.length,
      });
    }
    const { sessions, scopes } = summarizePlans(plans);
    return {
      mode: options.mode,
      db_path: paths.dbPath,
      data_dir: paths.dataDir,
      source_fingerprint: inventory.dbFingerprint,
      bundles: plans.length,
      sessions,
      scopes,
      table_rows: expectedExportCounts(inventory, relational.orphanCleanup),
      legacy_orphan_cleanup: relational.orphanCleanup,
      project_databases: projectDatabaseAudits.length,
      project_database_session_rows: aggregateProjectDatabaseRows(projectDatabaseAudits),
      blockers: blockers.map(({ pid, name }) => ({ pid, name })),
      process_audit_error: processAuditError,
    };
  } finally {
    db.close();
  }
}

async function verifyOnly(
  paths: ResolvedPaths,
  options: CliOptions,
): Promise<MigrationSummary> {
  assertNoInterruptedDatabaseSwap(dirname(paths.dbPath), paths.dbPath);
  const db = openDatabase(paths.dbPath, { readonly: true, fileMustExist: true });
  try {
    assertDatabaseIntegrity(db);
    assertCleanDatabase(db);
    assertPostCutWriteGuards(db);
    const marker = readLayoutMarker(db);
    if (marker !== String(SESSION_LAYOUT_VERSION)) {
      throw new Error('filesystem-session layout marker is absent or invalid');
    }
    const verified = verifyDiscoveredBundles(db, paths.dataDir);
    const projects = inventoryProjects(db);
    const projectDatabases = discoverProjectDatabases(
      projects,
      paths.dataDir,
      paths.dbPath,
    );
    const verifiedProjectDatabases = verifyProjectDatabasesClean(projectDatabases);
    return {
      mode: options.mode,
      db_path: paths.dbPath,
      data_dir: paths.dataDir,
      verified_bundles: verified,
      project_databases: verifiedProjectDatabases,
    };
  } finally {
    db.close();
  }
}

async function applyMigration(
  paths: ResolvedPaths,
  options: CliOptions,
  logger: Logger,
): Promise<MigrationSummary> {
  const processes = listProcesses();
  assertOffline(processes);
  assertSessionStorageRootAvailable(paths.dataDir, true);
  const lock = acquireMaintenanceLock(
    join(dirname(paths.dbPath), '.sessions-fs-migrate.lock'),
    paths.dbPath,
    processes,
  );
  let db: SqliteDatabase | null = null;
  try {
    const recovery = recoverInterruptedDatabaseSwap(
      dirname(paths.dbPath),
      paths.dbPath,
    );
    if (recovery.kind === 'rolled_back') {
      logger.warn('restored every source DB after an interrupted pre-commit swap', {
        fingerprint: recovery.journal.source_db_fingerprint,
      });
    } else if (recovery.kind === 'committed') {
      logger.warn('finishing a previously validated irreversible DB cut', {
        fingerprint: recovery.journal.source_db_fingerprint,
      });
      const journal = recovery.journal;
      validateSessionRootChains(
        journal.bundle_plans,
        journal.data_dir,
        false,
      );
      const verifiedBundles = journal.bundle_plans.reduce((count, plan) => {
        verifyBundle(
          plan.finalDir,
          plan.uuid,
          journal.source_db_fingerprint,
          'committed',
        );
        return count + 1;
      }, 0);
      await smokeOperationalBundleRepositories(journal.bundle_plans);
      const recoveredDb = openDatabase(paths.dbPath, {
        readonly: true,
        fileMustExist: true,
      });
      try {
        assertDatabaseIntegrity(recoveredDb);
        assertCleanDatabase(recoveredDb);
        assertPostCutWriteGuards(recoveredDb);
      } finally {
        recoveredDb.close();
      }
      verifyProjectDatabasesClean(
        journal.entries
          .filter((entry) => resolve(entry.db_path) !== resolve(paths.dbPath))
          .map((entry, index) => ({
            projectId: index + 1,
            path: entry.db_path,
          })),
      );
      const cleanup = cleanupLegacySessionSideStores(
        journal.data_dir,
        journal.bundle_plans,
        journal.run_dir,
        journal.source_db_path,
      );
      const { sessions, scopes } = summarizePlans(journal.bundle_plans);
      return {
        mode: options.mode,
        db_path: paths.dbPath,
        data_dir: paths.dataDir,
        source_fingerprint: journal.source_db_fingerprint,
        bundles: verifiedBundles,
        sessions,
        scopes,
        project_databases: Math.max(0, journal.entries.length - 1),
        cleanup: {
          removed_files: cleanup.removedFiles,
          removed_directories: cleanup.removedDirectories,
          skipped: cleanup.skipped,
        },
      };
    }
    db = openDatabase(paths.dbPath, { fileMustExist: true });
    checkpointWal(db);
    assertDatabaseIntegrity(db);
    assertSourceManifestCoverage(db);
    const marker = readLayoutMarker(db);
    if (marker === String(SESSION_LAYOUT_VERSION)) {
      throw new Error('database is already filesystem-session layout; use --verify-only');
    }
    if (marker != null) throw new Error(`unsupported session layout marker: ${marker}`);

    const inventory = inventorySource(db, paths.dbPath);
    const fingerprintShort = inventory.dbFingerprint.slice(0, 20);
    const runDir = join(dirname(paths.dbPath), '.sessions-fs-migrate', fingerprintShort);
    const statePath = join(runDir, 'migration-state.json');
    const uuidMapPath = join(runDir, 'uuid-map.json');
    const cleanDbPath = join(
      dirname(paths.dbPath),
      `.${basename(paths.dbPath)}.sessions-fs-${fingerprintShort}.clean`,
    );
    const registry = new UuidRegistry(uuidMapPath, inventory.dbFingerprint);
    const plans = buildPlansFailClosed(
      db,
      paths.dataDir,
      inventory.projects,
      registry,
      logger,
    );
    validateSessionRootChains(plans, paths.dataDir, true);
    validateSessionRootWriteAccess(plans, paths.dataDir);
    const roots = rootsForPlans(plans, paths.dataDir);
    validateRootsAndSpace(roots, paths.dbPath, inventory, false);
    const projectDatabases = discoverProjectDatabases(
      inventory.projects,
      paths.dataDir,
      paths.dbPath,
    );
    const projectDatabaseAudits = auditProjectDatabases(
      db,
      projectDatabases,
      { checkpoint: true },
    );
    for (const audit of projectDatabaseAudits) {
      assertWritableDirectory(dirname(audit.path));
      assertSpace(
        dirname(audit.path),
        Math.ceil(audit.sourceBytes * 2.25 + 64 * 1024 * 1024),
      );
    }
    assertWritableDirectory(runDir);
    const relational = buildRelationalExportIndex(db, plans, registry);
    const runState = createOrResumeState(
      statePath,
      inventory,
      roots,
      relational.orphanCleanup,
    );
    runState.phase = 'exporting';
    persistState(statePath, runState);

    const essential = captureEssentialDigest(db);
    const sealer = await createElectronSecretSealer();
    for (let index = 0; index < plans.length; index += 1) {
      const plan = plans[index];
      logger.info('exporting filesystem session bundle', {
        index: index + 1,
        total: plans.length,
        kind: plan.identity.kind,
        uuid: plan.uuid,
      });
      await ensureBundleExported(
        db,
        paths.dataDir,
        inventory,
        inventory.projects,
        plan,
        relational,
        sealer,
        logger,
        runState,
      );
      persistState(statePath, runState);
    }

    const stagedCounts = aggregateBundleCounts(plans, inventory.dbFingerprint);
    assertExportCounts(runState, stagedCounts);
    runState.exported_counts = stagedCounts;
    persistState(statePath, runState, 'exported');

    for (const plan of plans) {
      if (!existsSync(plan.finalDir)) {
        verifyBundle(plan.stagingDir, plan.uuid, inventory.dbFingerprint, 'staging');
        commitStagingBundle(plan, inventory.dbFingerprint);
      }
      verifyBundle(plan.finalDir, plan.uuid, inventory.dbFingerprint, 'committed');
    }
    const committedCounts = aggregateBundleCounts(plans, inventory.dbFingerprint);
    assertExportCounts(runState, committedCounts);
    await smokeOperationalBundleRepositories(plans);

    const preparedProjectDatabases = prepareCleanProjectDatabases(
      projectDatabaseAudits,
      inventory.dbFingerprint,
    );

    db.close();
    db = null;
    const cleanEssential = createCleanClone(
      paths.dbPath,
      cleanDbPath,
      essential,
      {},
    );
    await smokeCodeIndexDatabase(cleanDbPath, cleanEssential);
    runState.clean_clone_path = cleanDbPath;
    persistState(statePath, runState, 'clean_clone_verified');

    const swapStamp = `${Date.now()}-${fingerprintShort}`;
    const swapJournalPath = join(runDir, 'database-swaps.json');
    const centralBackupPath = databaseSwapBackupPath(paths.dbPath, swapStamp);
    const projectSwapSpecs = preparedProjectDatabases.map((prepared) => {
      const stamp = `${swapStamp}-project-${prepared.projectId}`;
      return {
        prepared,
        stamp,
        backupPath: databaseSwapBackupPath(prepared.path, stamp),
      };
    });
    let swapJournal: DatabaseSwapJournal = writeSwapJournal(
      swapJournalPath,
      {
        source_db_path: paths.dbPath,
        source_db_fingerprint: inventory.dbFingerprint,
        decision: 'rollback',
        entries: [
          {
            db_path: paths.dbPath,
            clean_path: cleanDbPath,
            backup_path: centralBackupPath,
            source_fingerprint: inventory.dbFingerprint,
          },
          ...projectSwapSpecs.map(({ prepared, backupPath }) => ({
            db_path: prepared.path,
            clean_path: prepared.cleanPath,
            backup_path: backupPath,
            source_fingerprint: prepared.sourceFingerprint,
          })),
        ],
        bundle_plans: [...plans],
        projects: [...inventory.projects],
        data_dir: paths.dataDir,
        run_dir: runDir,
      },
    );
    let swap: ReturnType<typeof swapCleanDatabase> | null = null;
    const projectSwaps: Array<{
      prepared: (typeof preparedProjectDatabases)[number];
      swap: ReturnType<typeof swapCleanDatabase>;
    }> = [];
    let irreversible = false;
    try {
      swap = swapCleanDatabase(
        paths.dbPath,
        cleanDbPath,
        swapStamp,
      );
      runState.old_db_path = swap.oldDbPath;
      persistState(statePath, runState, 'db_swapped');
      for (const spec of projectSwapSpecs) {
        const projectSwap = swapCleanDatabase(
          spec.prepared.path,
          spec.prepared.cleanPath,
          spec.stamp,
        );
        projectSwaps.push({ prepared: spec.prepared, swap: projectSwap });
      }
      await smokeCodeIndexDatabase(paths.dbPath, cleanEssential);
      for (const entry of projectSwaps) {
        smokeCleanProjectDatabase(entry.prepared.path, entry.prepared.essential);
      }
      const verifiedBundles = plans.reduce((count, plan) => {
        verifyBundle(plan.finalDir, plan.uuid, inventory.dbFingerprint, 'committed');
        return count + 1;
      }, 0);
      const finalCounts = aggregateBundleCounts(plans, inventory.dbFingerprint);
      assertExportCounts(runState, finalCounts);
      await smokeOperationalBundleRepositories(plans);
      persistState(statePath, runState, 'verified');
      // From here onward the cut is intentionally irreversible. Persist the
      // decision before deleting any source DB so a finalization error never
      // attempts a partial rollback after another DB was already finalized.
      swapJournal = commitSwapJournal(swapJournalPath, swapJournal);
      persistState(statePath, runState, 'complete');
      irreversible = true;
      for (const entry of projectSwaps) entry.swap.finalize();
      swap.finalize();
      const cleanup = cleanupLegacySessionSideStores(
        paths.dataDir,
        plans,
        runDir,
        paths.dbPath,
      );
      const { sessions, scopes } = summarizePlans(plans);
      return {
        mode: options.mode,
        db_path: paths.dbPath,
        data_dir: paths.dataDir,
        source_fingerprint: inventory.dbFingerprint,
        bundles: verifiedBundles,
        sessions,
        scopes,
        table_rows: finalCounts,
        legacy_orphan_cleanup: relational.orphanCleanup,
        project_databases: projectDatabaseAudits.length,
        project_database_session_rows: aggregateProjectDatabaseRows(projectDatabaseAudits),
        cleanup: {
          removed_files: cleanup.removedFiles,
          removed_directories: cleanup.removedDirectories,
          skipped: cleanup.skipped,
        },
      };
    } catch (error) {
      if (!irreversible) {
        for (const entry of [...projectSwaps].reverse()) entry.swap.rollback();
        swap?.rollback();
        discardSwapJournal(swapJournalPath);
        persistState(statePath, runState, 'exported');
      }
      throw error;
    }
  } finally {
    db?.close();
    lock.release();
  }
}

export async function runSessionsFsMigrationCli(args: readonly string[]): Promise<void> {
  assertElectronAbi();
  const options = parseCliArgs(args);
  const paths = resolvePaths(options);
  const logger = createLogger(options.json);
  logger.info('starting filesystem-session migration command', {
    mode: options.mode,
    db_path: paths.dbPath,
  });

  const summary = options.mode === 'dry-run'
    ? await dryRun(paths, options, logger)
    : options.mode === 'verify-only'
      ? await verifyOnly(paths, options)
      : await applyMigration(paths, options, logger);
  outputSummary(summary, options.json);
}
