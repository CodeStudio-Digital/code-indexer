import { createHash } from 'node:crypto';
import type {
  BundlePlan,
  LegacyOrphanCleanupAudit,
  LegacyEntityKind,
  SqliteDatabase,
} from './model.js';
import {
  DELETE_ROW_DISPOSITIONS,
  DROP_TABLES,
  LEGACY_ORPHAN_CLEANUP_DISPOSITIONS,
  POST_CUT_ROW_GUARDS,
  REDUNDANT_PROJECTION_TABLES,
  TABLE_DISPOSITIONS,
} from './manifest.js';
import type {
  LegacyOrphanParentRule,
} from './manifest.js';
import { quoteIdentifier, tableColumns, tableExists } from './db.js';
import type { UuidRegistry } from './uuid-map.js';

interface TableMeta {
  table: string;
  columns: string[];
  pkColumns: string[];
  identifierColumns: string[];
  foreignKeys: Array<{ from: string; table: string; to: string }>;
  whereSql?: string;
}

export interface MigratedRowStub {
  table: string;
  rowKey: string;
  entityUuid: string;
  legacyRowId: number;
  identifiers: Record<string, unknown>;
  owner: BundlePlan;
}

export interface RelationalExportIndex {
  rowsByTable: Map<string, MigratedRowStub[]>;
  rowByTableAndRowId: Map<string, MigratedRowStub>;
  orphanCleanup: Record<string, LegacyOrphanCleanupAudit>;
  orphanRowsByTable: ReadonlyMap<string, readonly LegacyOrphanRow[]>;
  uuidForReference(table: string, column: string, value: unknown): string | undefined;
  ownerForReference(table: string, column: string, value: unknown): BundlePlan | undefined;
  transformRow(table: string, row: Record<string, unknown>, stub: MigratedRowStub): Record<string, unknown>;
}

export interface LegacyOrphanRow {
  table: string;
  legacyRowId: number;
  identifiers: Record<string, unknown>;
}

interface MutableStub extends Omit<MigratedRowStub, 'owner'> {
  owner?: BundlePlan;
}

function planKey(kind: LegacyEntityKind, id: unknown): string {
  return `${kind}:${String(id)}`;
}

function tableMeta(db: SqliteDatabase, table: string, whereSql?: string): TableMeta {
  const info = db.prepare(`PRAGMA table_info(${quoteIdentifier(table)})`).all() as Array<{
    name: string;
    pk: number;
  }>;
  const columns = info.map((row) => row.name);
  const pkColumns = info.filter((row) => row.pk > 0).sort((a, b) => a.pk - b.pk).map((row) => row.name);
  const identifierColumns = columns.filter((column) => (
    column === 'id'
    || column.endsWith('_id')
    || column === 'ref'
    || column === 'partition_key'
    || column === 'scope_key'
    || column === 'scope_type'
    || column === 'session_kind'
  ));
  const foreignKeys = (db.prepare(`PRAGMA foreign_key_list(${quoteIdentifier(table)})`).all() as Array<{
    from: string;
    table: string;
    to: string;
  }>).map((row) => ({ from: row.from, table: row.table, to: row.to }));
  return { table, columns, pkColumns, identifierColumns, foreignKeys, whereSql };
}

function dispositionWhere(table: string): string | undefined {
  return DELETE_ROW_DISPOSITIONS.find((item) => item.table === table)?.whereSql;
}

function rootTableKind(table: string): LegacyEntityKind | undefined {
  switch (table) {
    case 'coder_sessions': return 'coder';
    case 'company_sessions': return 'company';
    case 'app_studio_sessions': return 'app_studio';
    case 'sprite_projects': return 'sprite';
    case 'design_system_sessions': return 'design';
    default: return undefined;
  }
}

function directOwner(
  table: string,
  values: Record<string, unknown>,
  plans: Map<string, BundlePlan>,
): BundlePlan | undefined {
  const rootKind = rootTableKind(table);
  if (rootKind) return plans.get(planKey(rootKind, values.id));

  if (table === 'docs_research_sessions') {
    if (values.parent_coder_session_id != null) {
      return plans.get(planKey('coder', values.parent_coder_session_id));
    }
    return plans.get(planKey('docs', values.id));
  }
  if (table === 'mcp_agent_runs') {
    if (values.session_id != null) return plans.get(planKey('coder', values.session_id));
    return plans.get(planKey('mcp_run', values.id));
  }

  if (values.app_session_id != null) {
    const owner = plans.get(planKey('app_studio', values.app_session_id));
    if (owner) return owner;
  }
  if (values.company_session_id != null) {
    const owner = plans.get(planKey('company', values.company_session_id));
    if (owner) return owner;
  }
  if (values.sprite_project_id != null) {
    const owner = plans.get(planKey('sprite', values.sprite_project_id));
    if (owner) return owner;
  }
  if (values.coder_session_id != null) {
    const owner = plans.get(planKey('coder', values.coder_session_id));
    if (owner) return owner;
  }
  if (values.parent_coder_session_id != null) {
    const owner = plans.get(planKey('coder', values.parent_coder_session_id));
    if (owner) return owner;
  }
  if (values.legacy_session_id != null) {
    const owner = plans.get(planKey('coder', values.legacy_session_id));
    if (owner) return owner;
  }
  if (values.session_id != null && typeof values.session_kind === 'string') {
    const normalized = values.session_kind.toLowerCase();
    const kind: LegacyEntityKind | undefined = normalized === 'company'
      ? 'company'
      : normalized === 'app_studio' || normalized === 'app-studio'
        ? 'app_studio'
        : normalized === 'sprite'
          ? 'sprite'
          : normalized === 'coder'
            ? 'coder'
            : undefined;
    if (kind) {
      const owner = plans.get(planKey(kind, values.session_id));
      if (owner) return owner;
    }
  }
  if (table === 'company_drive_files' && typeof values.scope_key === 'string') {
    const match = /^ses:(\d+)$/.exec(values.scope_key);
    if (match) return plans.get(planKey('company', Number(match[1])));
  }
  if (table === 'pipeline_provider_bindings' && values.scope_type === 'session') {
    const coder = plans.get(planKey('coder', values.scope_id));
    const companyPipeline = plans.get(planKey('company', values.scope_id));
    return coder ?? companyPipeline;
  }
  if (values.session_id != null && typeof values.session_id === 'number') {
    const disposition = TABLE_DISPOSITIONS.find(
      (item) => item.kind === 'drop' && item.table === table,
    );
    const companyOwned = disposition?.kind === 'drop'
      && disposition.exportOwner === 'company';
    return plans.get(planKey(companyOwned ? 'company' : 'coder', values.session_id));
  }
  return undefined;
}

function rowKey(table: string, row: Record<string, unknown>, meta: TableMeta): string {
  if (meta.pkColumns.length > 0) {
    return `${table}:${meta.pkColumns.map((column) => JSON.stringify(row[column])).join('|')}`;
  }
  return `${table}:rowid:${String(row.__rowid)}`;
}

function stringifyReference(value: unknown): string {
  if (typeof value === 'bigint') return value.toString();
  if (Buffer.isBuffer(value)) return `buffer:${value.toString('hex')}`;
  return JSON.stringify(value);
}

function referenceKey(table: string, column: string, value: unknown): string {
  return `${table}:${column}:${stringifyReference(value)}`;
}

function normalizeJsonValue(value: unknown): unknown {
  if (typeof value === 'bigint') {
    const numeric = Number(value);
    return Number.isSafeInteger(numeric) ? numeric : value.toString();
  }
  if (Buffer.isBuffer(value)) return { type: 'legacy_blob', base64: value.toString('base64') };
  return value;
}

function identifierAlias(table: string, column: string): string | undefined {
  const known: Record<string, string> = {
    command_id: 'session_commands',
    agent_run_id: 'agent_runs',
    attempt_id: 'agent_run_attempts',
    event_id: 'runtime_events',
    decision_id: 'policy_decisions',
    comparison_id: 'policy_decision_comparisons',
    grant_id: 'policy_grants',
    divergence_id: 'control_plane_divergences',
    message_id: 'coder_messages',
    execution_id: 'pipeline_executions',
    asset_id: 'sprite_assets',
    animation_id: 'sprite_animations',
    version_id: 'sprite_asset_versions',
    ds_session_id: 'design_system_sessions',
    company_agent_run_id: 'company_agent_runs',
    plan_revision_id: 'app_studio_plan_revisions',
    master_session_id: 'coder_sessions',
    coordinator_session_id: 'coder_sessions',
    parent_session_id: 'company_sessions',
  };
  if (column === 'id') return table;
  return known[column];
}

function discriminatorMatches(
  rule: LegacyOrphanParentRule,
  values: Record<string, unknown>,
): boolean {
  if (rule.kind !== 'session' || !rule.when) return true;
  const actual = values[rule.when.column];
  if (typeof actual !== 'string') return false;
  const normalized = actual.toLowerCase();
  return rule.when.values.some((value) => value.toLowerCase() === normalized);
}

function ownerCandidatesForRule(
  rule: LegacyOrphanParentRule,
  values: Record<string, unknown>,
  plans: ReadonlyMap<string, BundlePlan>,
  mutableRows: ReadonlyMap<string, readonly MutableStub[]>,
  refTargets: ReadonlyMap<string, MutableStub>,
): BundlePlan[] {
  if (!discriminatorMatches(rule, values)) return [];
  if (rule.kind === 'rootless') return [];
  const value = values[rule.column];
  if (value == null) return [];
  if (rule.kind === 'session') {
    const owner = plans.get(planKey(rule.sessionKind, value));
    return owner ? [owner] : [];
  }
  if (rule.kind === 'encoded_session') {
    if (typeof value !== 'string' || !value.startsWith(rule.prefix)) return [];
    const encodedId = value.slice(rule.prefix.length);
    const owner = plans.get(planKey(rule.sessionKind, encodedId));
    return owner ? [owner] : [];
  }
  if (rule.kind === 'record') {
    const target = refTargets.get(
      referenceKey(rule.targetTable, rule.targetColumn, value),
    );
    return target?.owner ? [target.owner] : [];
  }
  return (mutableRows.get(rule.sourceTable) ?? [])
    .filter((candidate) => (
      stringifyReference(candidate.identifiers[rule.sourceColumn])
      === stringifyReference(value)
    ))
    .flatMap((candidate) => candidate.owner ? [candidate.owner] : []);
}

function uniqueOwners(owners: readonly BundlePlan[]): BundlePlan[] {
  return [...new Map(owners.map((owner) => [owner.uuid, owner])).values()];
}

type ParentProofStatus = 'inapplicable' | 'live' | 'missing' | 'orphan' | 'pending';

function orphanParentStatus(
  rule: LegacyOrphanParentRule,
  values: Record<string, unknown>,
  plans: ReadonlyMap<string, BundlePlan>,
  mutableRows: ReadonlyMap<string, readonly MutableStub[]>,
  refTargets: ReadonlyMap<string, MutableStub>,
  orphanKeys: ReadonlySet<string>,
): ParentProofStatus {
  if (!discriminatorMatches(rule, values)) return 'inapplicable';
  if (rule.kind === 'rootless') {
    return rule.columns.every((column) => values[column] == null)
      ? 'missing'
      : 'inapplicable';
  }
  const value = values[rule.column];
  if (value == null) return 'inapplicable';
  if (rule.kind === 'session') {
    return plans.has(planKey(rule.sessionKind, value)) ? 'live' : 'missing';
  }
  if (rule.kind === 'encoded_session') {
    if (typeof value !== 'string' || !value.startsWith(rule.prefix)) return 'inapplicable';
    const encodedId = value.slice(rule.prefix.length);
    if (!encodedId) return 'pending';
    return plans.has(planKey(rule.sessionKind, encodedId)) ? 'live' : 'missing';
  }
  if (rule.kind === 'record') {
    const target = refTargets.get(
      referenceKey(rule.targetTable, rule.targetColumn, value),
    );
    if (!target) return 'missing';
    if (target.owner) return 'live';
    return orphanKeys.has(target.rowKey) ? 'orphan' : 'pending';
  }
  const targets = (mutableRows.get(rule.sourceTable) ?? []).filter((candidate) => (
    stringifyReference(candidate.identifiers[rule.sourceColumn])
    === stringifyReference(value)
  ));
  if (targets.length === 0) return 'missing';
  if (targets.some((candidate) => candidate.owner)) return 'live';
  return targets.every((candidate) => orphanKeys.has(candidate.rowKey))
    ? 'orphan'
    : 'pending';
}

function updateAuditHash(
  hash: ReturnType<typeof createHash>,
  value: string | Buffer,
): number {
  hash.update(value);
  return Buffer.isBuffer(value) ? value.length : Buffer.byteLength(value);
}

function updateAuditValue(
  hash: ReturnType<typeof createHash>,
  value: unknown,
): number {
  if (value === null || value === undefined) {
    return updateAuditHash(hash, 'n:;');
  }
  if (Buffer.isBuffer(value)) {
    let bytes = updateAuditHash(hash, `b:${value.length}:`);
    bytes += updateAuditHash(hash, value);
    bytes += updateAuditHash(hash, ';');
    return bytes;
  }
  const text = typeof value === 'bigint' ? value.toString() : String(value);
  return updateAuditHash(
    hash,
    `${typeof value}:${Buffer.byteLength(text)}:${text};`,
  );
}

function auditOrphanRows(
  db: SqliteDatabase,
  metas: ReadonlyMap<string, TableMeta>,
  orphanRowsByTable: ReadonlyMap<string, readonly MutableStub[]>,
): Record<string, LegacyOrphanCleanupAudit> {
  const output: Record<string, LegacyOrphanCleanupAudit> = {};
  for (const [table, stubs] of [...orphanRowsByTable.entries()]
    .sort(([left], [right]) => left.localeCompare(right))) {
    if (stubs.length === 0) continue;
    const rowIds = new Set(stubs.map((stub) => stub.legacyRowId));
    const meta = metas.get(table);
    if (!meta) throw new Error(`missing table metadata while auditing legacy orphans: ${table}`);
    const hash = createHash('sha256');
    let contentBytes = 0;
    let externalBytes = 0;
    let rows = 0;
    contentBytes += updateAuditHash(hash, `legacy_orphan_cleanup:v1:${table}\0`);
    const statement = db.prepare(
      `SELECT rowid AS __rowid, * FROM ${quoteIdentifier(table)} ORDER BY rowid`,
    );
    for (const row of statement.iterate() as Iterable<Record<string, unknown>>) {
      const rowId = Number(row.__rowid);
      if (!rowIds.has(rowId)) continue;
      rows += 1;
      contentBytes += updateAuditHash(hash, `rowid=${rowId};row{`);
      for (const column of meta.columns) {
        contentBytes += updateAuditHash(hash, `${column}=`);
        contentBytes += updateAuditValue(hash, row[column]);
      }
      contentBytes += updateAuditHash(hash, '}');
      if (table === 'company_drive_files') {
        const size = Number(row.size_bytes);
        if (Number.isSafeInteger(size) && size > 0) externalBytes += size;
      }
    }
    if (rows !== stubs.length) {
      throw new Error(
        `legacy orphan audit row mismatch for ${table}: expected=${stubs.length}, hashed=${rows}`,
      );
    }
    output[table] = {
      rows,
      content_bytes: contentBytes,
      sha256: hash.digest('hex'),
      ...(externalBytes > 0 ? { external_bytes: externalBytes } : {}),
    };
  }
  return output;
}

export function buildRelationalExportIndex(
  db: SqliteDatabase,
  bundlePlans: readonly BundlePlan[],
  registry: UuidRegistry,
): RelationalExportIndex {
  const plans = new Map(bundlePlans.map((plan) => [planKey(plan.identity.kind, plan.identity.id), plan]));
  const permanentRowGuards = new Set<string>(
    POST_CUT_ROW_GUARDS.map((guard) => guard.table),
  );
  const tables = [...new Set(TABLE_DISPOSITIONS.map((item) => item.table))]
    .filter((table) => tableExists(db, table))
    .filter((table) => !(REDUNDANT_PROJECTION_TABLES as readonly string[]).includes(table))
    .filter((table) => {
      const mixed = DELETE_ROW_DISPOSITIONS.find((item) => item.table === table);
      if (!mixed?.dropColumns?.length) return true;
      const columns = new Set(tableColumns(db, table));
      return (
        permanentRowGuards.has(table)
        || mixed.dropColumns.some((column) => columns.has(column))
      );
    });
  const metas = new Map(tables.map((table) => [table, tableMeta(db, table, dispositionWhere(table))]));
  const mutableRows = new Map<string, MutableStub[]>();
  const rowByTableAndRowId = new Map<string, MutableStub>();
  const refTargets = new Map<string, MutableStub>();
  const orphanDispositions = new Map(
    LEGACY_ORPHAN_CLEANUP_DISPOSITIONS.map((item) => [item.table, item]),
  );

  for (const table of tables) {
    if (table === 'projects') continue;
    const meta = metas.get(table)!;
    const selectedColumns = [...new Set([...meta.identifierColumns, ...meta.pkColumns])];
    const select = selectedColumns.length > 0
      ? `, ${selectedColumns.map(quoteIdentifier).join(', ')}`
      : '';
    const where = meta.whereSql ? ` WHERE ${meta.whereSql}` : '';
    const rows = db.prepare(
      `SELECT rowid AS __rowid${select} FROM ${quoteIdentifier(table)}${where}`,
    ).all() as Array<Record<string, unknown>>;
    const stubs: MutableStub[] = [];

    for (const values of rows) {
      const key = rowKey(table, values, meta);
      let entityUuid: string;
      const rootKind = rootTableKind(table);
      if (rootKind && values.id != null) {
        entityUuid = registry.forSession({ kind: rootKind, id: values.id as string | number });
      } else if (table === 'docs_research_sessions' && values.parent_coder_session_id == null) {
        entityUuid = registry.forSession({ kind: 'docs', id: values.id as string | number });
      } else if (table === 'mcp_agent_runs' && values.session_id == null) {
        entityUuid = registry.forSession({ kind: 'mcp_run', id: values.id as string | number });
      } else {
        entityUuid = registry.getOrCreate(key);
      }
      registry.alias(key, entityUuid);
      const legacyRowId = Number(values.__rowid);
      const stub: MutableStub = {
        table,
        rowKey: key,
        entityUuid,
        legacyRowId,
        identifiers: values,
        owner: directOwner(table, values, plans),
      };
      stubs.push(stub);
      rowByTableAndRowId.set(`${table}:${legacyRowId}`, stub);

      for (const column of selectedColumns) {
        const value = values[column];
        if (value == null) continue;
        refTargets.set(referenceKey(table, column, value), stub);
      }
    }
    mutableRows.set(table, stubs);
  }
  registry.save();

  for (let pass = 0; pass < tables.length + 4; pass += 1) {
    let changed = false;
    for (const [table, rows] of mutableRows) {
      const meta = metas.get(table)!;
      for (const row of rows) {
        if (row.owner) continue;
        const explicit = orphanDispositions.get(table);
        let explicitOwner: BundlePlan | undefined;
        for (const rule of explicit?.parents ?? []) {
          const owners = uniqueOwners(
            ownerCandidatesForRule(rule, row.identifiers, plans, mutableRows, refTargets),
          );
          if (owners.length > 1) {
            throw new Error(
              `explicit ownership parent resolves to multiple sessions: table=${table} row=${row.rowKey}`,
            );
          }
          if (owners.length === 1) {
            explicitOwner = owners[0];
            break;
          }
        }
        if (explicitOwner) {
          row.owner = explicitOwner;
          changed = true;
          continue;
        }

        const candidates: BundlePlan[] = [];
        for (const fk of meta.foreignKeys) {
          const value = row.identifiers[fk.from];
          if (value == null) continue;
          const target = refTargets.get(referenceKey(fk.table, fk.to, value));
          if (target?.owner) candidates.push(target.owner);
        }
        const owners = uniqueOwners(candidates);
        if (owners.length > 1) {
          throw new Error(
            `row has conflicting explicit session owners: table=${table} row=${row.rowKey} owners=${owners.map((owner) => owner.uuid).join(',')}`,
          );
        }
        if (owners.length === 1) {
          row.owner = owners[0];
          changed = true;
          continue;
        }
        if (table === 'runtime_projection_cursors' && typeof row.identifiers.partition_key === 'string') {
          const partition = row.identifiers.partition_key;
          const controlPlaneRows = mutableRows.get('control_plane_sessions') ?? [];
          const matches = controlPlaneRows.filter((candidate) => {
            const id = candidate.identifiers.session_id;
            return typeof id === 'string' && (partition === id || partition.includes(id));
          });
          const partitionOwners = uniqueOwners(
            matches.flatMap((candidate) => candidate.owner ? [candidate.owner] : []),
          );
          if (partitionOwners.length > 1) {
            throw new Error(
              `runtime projection cursor matches multiple session owners: ${row.rowKey}`,
            );
          }
          if (partitionOwners.length === 1) {
            row.owner = partitionOwners[0];
            changed = true;
          }
        }
      }
    }
    if (!changed) break;
  }

  const unowned = [...mutableRows.values()].flat().filter((row) => !row.owner);
  const orphanKeys = new Set<string>();
  for (let pass = 0; pass < unowned.length + 1; pass += 1) {
    let changed = false;
    for (const row of unowned) {
      if (orphanKeys.has(row.rowKey)) continue;
      const disposition = orphanDispositions.get(row.table);
      if (!disposition) continue;
      const statuses = disposition.parents.map((rule) => orphanParentStatus(
        rule,
        row.identifiers,
        plans,
        mutableRows,
        refTargets,
        orphanKeys,
      ));
      const applicable = statuses.filter((status) => status !== 'inapplicable');
      if (applicable.length === 0 || applicable.includes('live') || applicable.includes('pending')) {
        continue;
      }
      if (applicable.some((status) => status === 'missing' || status === 'orphan')) {
        orphanKeys.add(row.rowKey);
        changed = true;
      }
    }
    if (!changed) break;
  }

  const unresolved = unowned.filter((row) => !orphanKeys.has(row.rowKey));
  if (unresolved.length > 0) {
    const byTable = Object.fromEntries(
      [...unresolved.reduce((counts, row) => {
        counts.set(row.table, (counts.get(row.table) ?? 0) + 1);
        return counts;
      }, new Map<string, number>())]
        .sort(([left], [right]) => left.localeCompare(right)),
    );
    const sample = unresolved.slice(0, 30).map((row) => ({
      table: row.table,
      identifiers: row.identifiers,
    }));
    throw new Error(
      `cannot assign ${unresolved.length} session-scoped row(s) to a bundle and cannot prove explicit legacy orphan cleanup; refusing data loss; by_table=${JSON.stringify(byTable)}; sample=${JSON.stringify(sample)}`,
    );
  }

  const orphanRowsByTable = new Map<string, MutableStub[]>();
  for (const row of unowned) {
    const rows = orphanRowsByTable.get(row.table) ?? [];
    rows.push(row);
    orphanRowsByTable.set(row.table, rows);
  }
  const orphanCleanup = auditOrphanRows(db, metas, orphanRowsByTable);
  const rowsByTable = new Map<string, MigratedRowStub[]>();
  for (const [table, rows] of mutableRows) {
    rowsByTable.set(
      table,
      rows.filter((row) => row.owner) as MigratedRowStub[],
    );
  }
  for (const row of unowned) rowByTableAndRowId.delete(`${row.table}:${row.legacyRowId}`);

  const uuidForReference = (table: string, column: string, value: unknown): string | undefined =>
    refTargets.get(referenceKey(table, column, value))?.entityUuid;
  const ownerForReference = (table: string, column: string, value: unknown): BundlePlan | undefined =>
    refTargets.get(referenceKey(table, column, value))?.owner;

  return {
    rowsByTable,
    rowByTableAndRowId: rowByTableAndRowId as Map<string, MigratedRowStub>,
    orphanCleanup,
    orphanRowsByTable,
    uuidForReference,
    ownerForReference,
    transformRow(table, row, stub) {
      const meta = metas.get(table)!;
      const output: Record<string, unknown> = {
        schema_version: 1,
        id: stub.entityUuid,
      };
      for (const [column, raw] of Object.entries(row)) {
        if (column === '__rowid' || column === 'id') continue;
        if (column === 'legacy_session_id') continue;
        let value = normalizeJsonValue(raw);
        if (value == null) {
          output[column] = value;
          continue;
        }
        if (column === 'session_id') {
          output.session_id = stub.owner.uuid;
          continue;
        }
        if (column === 'coder_session_id' || column === 'parent_coder_session_id') {
          output[column === 'parent_coder_session_id' ? 'parent_session_id' : 'session_id'] =
            plans.get(planKey('coder', value))?.uuid ?? stub.owner.uuid;
          continue;
        }
        if (column === 'company_session_id') {
          output.company_session_id = plans.get(planKey('company', value))?.uuid ?? stub.owner.uuid;
          continue;
        }
        if (column === 'app_session_id') {
          output.app_session_id = plans.get(planKey('app_studio', value))?.uuid ?? stub.owner.uuid;
          continue;
        }
        if (column === 'sprite_project_id') {
          output.sprite_session_id = plans.get(planKey('sprite', value))?.uuid ?? stub.owner.uuid;
          continue;
        }
        if (
          table === 'pipeline_provider_bindings'
          && column === 'scope_id'
          && row.scope_type === 'session'
        ) {
          output.scope_id = stub.owner.uuid;
          continue;
        }
        const fk = meta.foreignKeys.find((candidate) => candidate.from === column);
        const aliasTable = fk?.table ?? identifierAlias(table, column);
        if (aliasTable) {
          const replacement = uuidForReference(aliasTable, fk?.to ?? column, value)
            ?? uuidForReference(aliasTable, 'id', value);
          if (replacement) {
            output[column] = replacement;
            continue;
          }
        }
        output[column] = value;
      }
      return output;
    },
  };
}

export function allRemovedTables(): readonly string[] {
  return DROP_TABLES;
}
