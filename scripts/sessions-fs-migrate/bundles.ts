import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  unlinkSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type {
  BundlePlan,
  LegacyEntityKind,
  LegacyIdentity,
  ProjectRow,
  SqliteDatabase,
} from './model.js';
import {
  atomicWriteJson,
  readJsonFile,
  syncParentDirectory,
} from './fs-ops.js';
import { tableColumns, tableExists } from './db.js';
import type { UuidRegistry } from './uuid-map.js';
import type { MigrationFile } from './model.js';

export const REQUIRED_BUNDLE_DIRECTORIES = [
  'attachments',
  'tools_outputs',
  'snapshots',
  'metrics',
  'metrics/turns',
  'metrics/provider_attempts',
  'metrics/pipeline_stages',
  'events',
  'checkpoints',
  'chapters',
  'plans',
  'tasks',
  'inputs',
  'memory',
  'subagents',
  'company',
  'sprite',
] as const;

interface BundleRoots {
  globalRoot: string;
  projectRoots: Map<number, string>;
}

interface CoderRow {
  id: number;
  project_id: number;
  is_global?: number;
}

interface CompanyRow {
  id: number;
  master_session_id?: number | null;
  parent_session_id?: number | null;
  runtime_kind?: string | null;
}

interface AppRow {
  id: number | string;
  project_id?: number | null;
  company_session_id?: number | null;
  coordinator_session_id?: number | null;
}

interface SpriteRow {
  id: number;
  project_id: number;
}

export class MissingProjectCatalogEntryError extends Error {
  readonly projectId: number;
  readonly ownerLabel: string;

  constructor(projectId: number, ownerLabel: string) {
    super(`${ownerLabel} references missing project root ${projectId}`);
    this.name = 'MissingProjectCatalogEntryError';
    this.projectId = projectId;
    this.ownerLabel = ownerLabel;
  }
}

function selectKnownColumns<T>(
  db: SqliteDatabase,
  table: string,
  desired: readonly string[],
): T[] {
  if (!tableExists(db, table)) return [];
  const available = new Set(tableColumns(db, table));
  const selected = desired.filter((column) => available.has(column));
  if (!selected.includes('id')) return [];
  return db.prepare(
    `SELECT ${selected.map((column) => `"${column}"`).join(', ')} FROM "${table}" ORDER BY id`,
  ).all() as T[];
}

function projectLinks(
  db: SqliteDatabase,
  table: string,
  sessionColumn: string,
): Map<number, number[]> {
  const output = new Map<number, number[]>();
  if (!tableExists(db, table)) return output;
  const columns = new Set(tableColumns(db, table));
  if (!columns.has(sessionColumn) || !columns.has('project_id')) return output;
  const rows = db.prepare(
    `SELECT "${sessionColumn}" AS session_id, project_id FROM "${table}" ORDER BY project_id`,
  ).all() as Array<{ session_id: number; project_id: number }>;
  for (const row of rows) {
    const values = output.get(row.session_id) ?? [];
    if (!values.includes(row.project_id)) values.push(row.project_id);
    output.set(row.session_id, values);
  }
  return output;
}

function requireProjectRoot(roots: BundleRoots, projectId: number, label: string): string {
  const root = roots.projectRoots.get(projectId);
  if (!root) throw new MissingProjectCatalogEntryError(projectId, label);
  if (!existsSync(root)) throw new Error(`${label} project root is unavailable: ${root}`);
  return root;
}

function makePlan(
  identity: LegacyIdentity,
  uuid: string,
  scope: 'project' | 'global',
  roots: BundleRoots,
  projectRoot?: string,
): BundlePlan {
  const sessionRoot = scope === 'global'
    ? join(roots.globalRoot, 'sessions', 'global')
    : join(projectRoot!, '.mcp-indexer', 'session');
  return {
    identity,
    uuid,
    scope,
    projectRoot,
    finalDir: join(sessionRoot, uuid),
    stagingDir: join(sessionRoot, `.migrating-${uuid}`),
  };
}

function aliasSession(
  registry: UuidRegistry,
  kind: LegacyEntityKind,
  id: number | string,
  table: string,
): string {
  const uuid = registry.forSession({ kind, id });
  registry.alias(`${table}:${String(id)}`, uuid);
  return uuid;
}

export function buildBundlePlans(
  db: SqliteDatabase,
  dataDir: string,
  projects: readonly ProjectRow[],
  registry: UuidRegistry,
): BundlePlan[] {
  const roots: BundleRoots = {
    globalRoot: resolve(dataDir),
    projectRoots: new Map(
      projects
        .filter((project) => Number(project.id) !== 0 && !project.is_synthetic)
        .map((project) => [Number(project.id), resolve(project.root_path)]),
    ),
  };
  const syntheticProjectIds = new Set(
    projects
      .filter((project) => Boolean(project.is_synthetic))
      .map((project) => Number(project.id)),
  );
  const plans: BundlePlan[] = [];
  const planByIdentity = new Map<string, BundlePlan>();
  const addPlan = (
    identity: LegacyIdentity,
    scope: 'project' | 'global',
    projectRoot?: string,
    table = `${identity.kind}_sessions`,
  ): BundlePlan => {
    const key = `${identity.kind}:${identity.id}`;
    const existing = planByIdentity.get(key);
    if (existing) return existing;
    const uuid = aliasSession(registry, identity.kind, identity.id, table);
    const plan = makePlan(identity, uuid, scope, roots, projectRoot);
    planByIdentity.set(key, plan);
    plans.push(plan);
    return plan;
  };

  const coderRows = selectKnownColumns<CoderRow>(
    db,
    'coder_sessions',
    ['id', 'project_id', 'is_global'],
  );
  const companyRows = selectKnownColumns<CompanyRow>(
    db,
    'company_sessions',
    ['id', 'master_session_id', 'parent_session_id', 'runtime_kind'],
  );
  const appRows = selectKnownColumns<AppRow>(
    db,
    'app_studio_sessions',
    ['id', 'project_id', 'company_session_id', 'coordinator_session_id'],
  );
  const spriteRows = selectKnownColumns<SpriteRow>(
    db,
    'sprite_projects',
    ['id', 'project_id'],
  );
  const coderLinks = projectLinks(db, 'coder_session_projects', 'coder_session_id');
  const companyLinks = projectLinks(db, 'company_session_projects', 'company_session_id');
  const coderById = new Map(coderRows.map((row) => [row.id, row]));
  const forcedCoderScope = new Map<number, { scope: 'project' | 'global'; projectRoot?: string }>();

  for (const company of companyRows) {
    const directLinks = companyLinks.get(company.id) ?? [];
    const master = company.master_session_id == null
      ? undefined
      : coderById.get(company.master_session_id);
    const inheritedLinks = company.master_session_id == null
      ? []
      : coderLinks.get(company.master_session_id) ?? [];
    const links = directLinks.length > 0
      ? directLinks
      : inheritedLinks.length > 0
        ? inheritedLinks
        : master
          ? [master.project_id]
          : [];
    const scope = links.length > 1 || company.runtime_kind === 'app_studio' ? 'global' : 'project';
    const projectId = links[0];
    if (scope === 'project' && projectId == null) {
      throw new Error(
        `Company session ${company.id} has no project link and no project-owned master session`,
      );
    }
    const projectRoot = scope === 'project'
      ? requireProjectRoot(roots, projectId, `Company session ${company.id}`)
      : undefined;
    addPlan({ kind: 'company', id: company.id }, scope, projectRoot, 'company_sessions');
    if (company.master_session_id != null) {
      forcedCoderScope.set(company.master_session_id, { scope, projectRoot });
    }
  }

  if (tableExists(db, 'company_agent_runs')) {
    const columns = new Set(tableColumns(db, 'company_agent_runs'));
    if (columns.has('company_session_id') && columns.has('coder_session_id')) {
      const rows = db.prepare(
        `SELECT company_session_id, coder_session_id FROM company_agent_runs`,
      ).all() as Array<{ company_session_id: number; coder_session_id: number }>;
      for (const row of rows) {
        const companyPlan = planByIdentity.get(`company:${row.company_session_id}`);
        if (companyPlan) {
          forcedCoderScope.set(row.coder_session_id, {
            scope: companyPlan.scope,
            projectRoot: companyPlan.projectRoot,
          });
        }
      }
    }
  }

  for (const app of appRows) {
    const plan = addPlan({ kind: 'app_studio', id: app.id }, 'global', undefined, 'app_studio_sessions');
    if (app.coordinator_session_id != null) {
      forcedCoderScope.set(app.coordinator_session_id, { scope: 'global' });
    }
    if (app.company_session_id != null) {
      const companyPlan = planByIdentity.get(`company:${app.company_session_id}`);
      if (companyPlan && companyPlan.scope !== 'global') {
        throw new Error(
          `App Studio ${app.id} references non-global Company session ${app.company_session_id}`,
        );
      }
    }
    void plan;
  }

  for (const coder of coderRows) {
    const forced = forcedCoderScope.get(coder.id);
    const links = coderLinks.get(coder.id) ?? [];
    const isGlobal = (
      forced?.scope === 'global'
      || Boolean(coder.is_global)
      || syntheticProjectIds.has(coder.project_id)
      || links.length > 1
    );
    const projectRoot = isGlobal
      ? undefined
      : forced?.projectRoot
        ?? requireProjectRoot(roots, coder.project_id, `Coder session ${coder.id}`);
    addPlan(
      { kind: 'coder', id: coder.id },
      isGlobal ? 'global' : 'project',
      projectRoot,
      'coder_sessions',
    );
  }

  for (const sprite of spriteRows) {
    const projectRoot = requireProjectRoot(roots, sprite.project_id, `Sprite project ${sprite.id}`);
    addPlan({ kind: 'sprite', id: sprite.id }, 'project', projectRoot, 'sprite_projects');
  }

  if (tableExists(db, 'design_system_sessions')) {
    const columns = new Set(tableColumns(db, 'design_system_sessions'));
    if (!columns.has('id') || !columns.has('company_session_id')) {
      throw new Error('design_system_sessions is missing its ownership columns');
    }
    const projectExpression = columns.has('project_id')
      ? 'project_id'
      : 'NULL AS project_id';
    const rows = db.prepare(
      `SELECT id, company_session_id, ${projectExpression}
       FROM design_system_sessions ORDER BY id`,
    ).all() as Array<{
      id: number;
      company_session_id: number | null;
      project_id: number | null;
    }>;
    for (const row of rows) {
      if (row.company_session_id != null) {
        const parent = planByIdentity.get(`company:${row.company_session_id}`);
        if (!parent) {
          throw new Error(
            `Design session ${row.id} references missing Company session ${row.company_session_id}`,
          );
        }
        addPlan(
          { kind: 'design', id: row.id },
          parent.scope,
          parent.projectRoot,
          'design_system_sessions',
        );
        continue;
      }
      if (row.project_id == null) {
        throw new Error(`Design session ${row.id} has neither Company nor project owner`);
      }
      addPlan(
        { kind: 'design', id: row.id },
        'project',
        requireProjectRoot(roots, row.project_id, `Design session ${row.id}`),
        'design_system_sessions',
      );
    }
  }

  if (tableExists(db, 'docs_research_sessions')) {
    const rows = db.prepare(
      `SELECT id, parent_coder_session_id FROM docs_research_sessions ORDER BY id`,
    ).all() as Array<{ id: number; parent_coder_session_id: number | null }>;
    for (const row of rows) {
      if (row.parent_coder_session_id != null) continue;
      addPlan({ kind: 'docs', id: row.id }, 'global', undefined, 'docs_research_sessions');
    }
  }

  if (tableExists(db, 'mcp_agent_runs')) {
    const rows = db.prepare(
      `SELECT id, session_id FROM mcp_agent_runs ORDER BY id`,
    ).all() as Array<{ id: string; session_id: number | null }>;
    for (const row of rows) {
      if (row.session_id != null) continue;
      addPlan({ kind: 'mcp_run', id: row.id }, 'global', undefined, 'mcp_agent_runs');
    }
  }

  registry.save();
  return plans;
}

function assertCommittedMarker(
  marker: MigrationFile,
  plan: BundlePlan,
  sourceFingerprint: string,
): void {
  if (
    marker.session_uuid !== plan.uuid
    || marker.source_db_fingerprint !== sourceFingerprint
    || marker.phase !== 'committed'
    || !marker.committed_at
  ) {
    throw new Error(
      `destination bundle has no valid committed marker for this migration: ${plan.finalDir}`,
    );
  }
}

export function promoteInterruptedFinalBundle(
  plan: BundlePlan,
  sourceFingerprint: string,
): boolean {
  if (!existsSync(plan.finalDir)) return false;
  const markerPath = join(plan.finalDir, 'migration.json');
  const marker = readJsonFile<MigrationFile>(markerPath);
  if (marker.phase === 'committed') {
    assertCommittedMarker(marker, plan, sourceFingerprint);
    return false;
  }
  if (
    marker.phase !== 'staging'
    || marker.session_uuid !== plan.uuid
    || marker.source_db_fingerprint !== sourceFingerprint
  ) {
    throw new Error(`cannot recover interrupted final bundle marker: ${markerPath}`);
  }
  atomicWriteJson(markerPath, {
    ...marker,
    phase: 'committed',
    committed_at: new Date().toISOString(),
  } satisfies MigrationFile);
  assertCommittedMarker(
    readJsonFile<MigrationFile>(markerPath),
    plan,
    sourceFingerprint,
  );
  return true;
}

export function resetStagingBundle(plan: BundlePlan): void {
  if (!existsSync(plan.stagingDir)) return;
  const expectedParent = dirname(plan.finalDir);
  if (
    dirname(plan.stagingDir) !== expectedParent
    || resolve(plan.stagingDir) === resolve(expectedParent)
    || !plan.stagingDir.endsWith(`.migrating-${plan.uuid}`)
  ) {
    throw new Error(`refusing to reset unexpected staging path: ${plan.stagingDir}`);
  }
  const stat = lstatSync(plan.stagingDir);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(`refusing to recursively reset non-directory staging path: ${plan.stagingDir}`);
  }
  rmSync(plan.stagingDir, { recursive: true, force: false });
}

function isKnownAtomicTemporary(name: string): boolean {
  return (
    /^\.\d+-\d+-[a-f0-9]{8}\.tmp$/i.test(name)
    || /^\..+\.tmp-\d+-[0-9a-f-]{36}$/i.test(name)
  );
}

export function collectBundleTemporaryFiles(bundlePath: string): number {
  if (!existsSync(bundlePath)) return 0;
  let removed = 0;
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) {
        throw new Error(`bundle temporary-file collection found a link: ${path}`);
      }
      if (stat.isDirectory()) {
        visit(path);
      } else if (stat.isFile() && isKnownAtomicTemporary(entry.name)) {
        unlinkSync(path);
        removed += 1;
      }
    }
  };
  visit(bundlePath);
  return removed;
}

export function prepareStagingBundle(
  plan: BundlePlan,
  sourceFingerprint: string,
): void {
  if (existsSync(plan.finalDir)) {
    const markerPath = join(plan.finalDir, 'migration.json');
    if (!existsSync(markerPath)) {
      throw new Error(`destination bundle exists without migration marker: ${plan.finalDir}`);
    }
    assertCommittedMarker(readJsonFile<MigrationFile>(markerPath), plan, sourceFingerprint);
    return;
  }
  mkdirSync(plan.stagingDir, { recursive: true });
  for (const directory of REQUIRED_BUNDLE_DIRECTORIES) {
    mkdirSync(join(plan.stagingDir, ...directory.split('/')), { recursive: true });
  }
}

export function commitStagingBundle(
  plan: BundlePlan,
  sourceFingerprint: string,
): void {
  if (existsSync(plan.finalDir)) {
    const marker = readJsonFile<MigrationFile>(join(plan.finalDir, 'migration.json'));
    assertCommittedMarker(marker, plan, sourceFingerprint);
    return;
  }
  if (!existsSync(plan.stagingDir)) {
    throw new Error(`missing staging bundle: ${plan.stagingDir}`);
  }
  if (dirname(plan.stagingDir) !== dirname(plan.finalDir)) {
    throw new Error(
      `bundle staging must share the destination directory/volume: ${plan.stagingDir}`,
    );
  }
  const markerPath = join(plan.stagingDir, 'migration.json');
  const marker = readJsonFile<MigrationFile>(markerPath);
  if (
    marker.session_uuid !== plan.uuid
    || marker.source_db_fingerprint !== sourceFingerprint
    || marker.phase !== 'staging'
  ) {
    throw new Error(`invalid staging migration marker: ${markerPath}`);
  }
  renameSync(plan.stagingDir, plan.finalDir);
  syncParentDirectory(plan.finalDir);
  atomicWriteJson(join(plan.finalDir, 'migration.json'), {
    ...marker,
    phase: 'committed',
    committed_at: new Date().toISOString(),
  } satisfies MigrationFile);
  assertCommittedMarker(
    readJsonFile<MigrationFile>(join(plan.finalDir, 'migration.json')),
    plan,
    sourceFingerprint,
  );
}

export function discoverBundleDirs(root: string): string[] {
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /^[0-9a-f-]{36}$/i.test(entry.name))
    .map((entry) => join(root, entry.name));
}
