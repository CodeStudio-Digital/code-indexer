/**
 * Left-rail connection tree. Saved connections are roots; expanding one connects
 * (if needed) and lazily fetches databases → schemas → tables → columns. Each
 * level fetches its children on first expand and shows a per-node spinner.
 */
import { useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useVirtualizer } from '@tanstack/react-virtual';
import {
  ChevronRight, ChevronDown, Database, Table2, Eye, Columns3, Box, Loader2,
  Plus, RefreshCw, MoreVertical, Plug, PlugZap, Folder, KeyRound, Link2, Zap, Braces, Hash, Search,
} from 'lucide-react';
import {
  DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem,
} from '../../../components/ui/dropdown-menu.js';
import { confirm, prompt, toast } from '../../../components/ui/prompt-dialog.js';
import { useContextMenu, type ContextMenuItem } from '../../../components/ui/context-menu.js';
import { copyText } from '../../../lib/clipboard.js';
import { toCsv, toCsvBody, toDumpInserts } from '../grid/grid-export.js';
import { beginUiDatabaseJob, DatabaseJobProgress } from '../job-progress.js';
import { createExportWriter } from '../export-writer.js';
import { splitStatements } from '../query/sql-split.js';
import * as api from '../api.js';
import { engineKindFor } from '../engines.js';
import type { UseDbClient } from '../useDbClient.js';
import type { DbConnection, DbConnectionStatus, DbTreeNode } from '../types.js';

/**
 * Export a whole table to a downloaded file, streaming server-paged batches so
 * neither side holds the table at once and there's no row cap. SQL prepends a
 * CREATE; CSV writes the header once then appends each batch's rows.
 */
async function exportTable(
  node: DbTreeNode,
  cid: string,
  db: UseDbClient,
  format: 'sql' | 'csv',
  t: (k: string, o?: Record<string, unknown>) => string,
): Promise<void> {
  const tbl = node.table ?? '';
  const engine = db.connections.find((c) => c.id === node.connectionId)?.engine ?? 'postgres';
  const ext = format === 'csv' ? 'csv' : 'sql';
  let writer: Awaited<ReturnType<typeof createExportWriter>> = null;
  let job: ReturnType<typeof beginUiDatabaseJob> | undefined;
  try {
    writer = await createExportWriter(tbl + '.' + ext, format === 'csv' ? 'text/csv' : 'application/sql');
    if (!writer) return;
    job = beginUiDatabaseJob(cid, t('node.dumpSql'));
    if (format === 'sql') {
      const { sql: createSql } = await api.generateSql(cid, node.schema, tbl, 'create');
      await writer.write(createSql.trim() + '\n');
    }
    let total = 0, csvHeaderDone = false;
    job.signal.throwIfAborted();
    for await (const batch of api.exportStream(cid, node.schema, tbl, 1000, job.id)) {
      job.signal.throwIfAborted();
      total = batch.total; job.progress(total);
      if (!batch.rows.length) continue;
      await writer.write((format === 'csv'
        ? csvHeaderDone ? toCsvBody(batch.columns, batch.rows) : toCsv(batch.columns, batch.rows)
        : toDumpInserts(engine, tbl, batch.columns, batch.rows)) + '\n');
      csvHeaderDone = true;
    }
    job.signal.throwIfAborted();
    await writer.close(); job.finish(true);
    toast.success(t('node.dumpDone', { n: total }));
  } catch (e) {
    job?.finish(false); await writer?.abort().catch(() => undefined);
    toast.error(t('node.dumpSql'), { description: e instanceof Error ? e.message : String(e) });
  }
}

/** Open a native file picker and resolve the chosen file (or null if cancelled). */
function pickFile(accept: string): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.onchange = () => resolve(input.files?.[0] ?? null);
    // `cancel` fires when the dialog is dismissed (supported in modern Chromium/Electron).
    input.addEventListener('cancel', () => resolve(null));
    input.click();
  });
}

/**
 * Dump a whole schema (CREATE + INSERTs) to a .sql file. Streams each frame
 * straight to disk via the File System Access API so a huge dump never sits in
 * renderer memory; falls back to an in-memory Blob download where that API is
 * unavailable (browser-dev).
 */
async function dumpSchema(node: DbTreeNode, cid: string, t: (k: string, o?: Record<string, unknown>) => string): Promise<void> {
  let writer: Awaited<ReturnType<typeof createExportWriter>> = null;
  let job: ReturnType<typeof beginUiDatabaseJob> | undefined;
  try {
    writer = await createExportWriter((node.schema || 'dump') + '.sql', 'application/sql');
    if (!writer) return;
    job = beginUiDatabaseJob(cid, t('node.dumpSchema'));
    job.signal.throwIfAborted();
    let total = 0;
    for await (const frame of api.dumpStream(cid, { schema: node.schema, jobId: job.id })) {
      job.signal.throwIfAborted();
      if (frame.sql) await writer.write(frame.sql);
      total = frame.total; job.progress(total);
    }
    job.signal.throwIfAborted(); await writer.close(); job.finish(true);
    toast.success(t('node.dumpDone', { n: total }));
  } catch (e) {
    job?.finish(false); await writer?.abort().catch(() => undefined);
    toast.error(t('node.dumpSchema'), { description: e instanceof Error ? e.message : String(e) });
  }
}

/** Restore: pick a .sql file, split into statements, run them on one pinned connection. */
async function restoreScript(node: DbTreeNode, cid: string, db: UseDbClient, t: (k: string, o?: Record<string, unknown>) => string): Promise<void> {
  const file = await pickFile('.sql,application/sql,text/plain');
  if (!file) return;
  try {
    if (file.size > 16 * 1024 * 1024) throw new Error('Import exceeds 16 MiB. Split the import into reviewed batches.');
    const stmts = splitStatements(await file.text());
    if (stmts.length === 0) { toast.warning(t('node.restoreEmpty')); return; }
    if (!(await confirm({ title: t('node.restore'), description: t('node.restoreConfirm', { n: stmts.length }), tone: 'destructive' }))) return;
    const job = beginUiDatabaseJob(cid, t('node.restore'), 'import');
    try { await api.runScript(cid, stmts, { jobId: job.id, signal: job.signal }); job.finish(true); }
    catch (error) { job.finish(false); throw error; }
    toast.success(t('node.restoreDone', { n: stmts.length }));
    db.refreshNode(node.id);
  } catch (e) {
    toast.error(t('node.restore'), { description: e instanceof Error ? e.message : String(e) });
  }
}

/** Import a JSON file (array of docs, or a single doc) into a Mongo collection. */
async function importJson(node: DbTreeNode, cid: string, t: (k: string, o?: Record<string, unknown>) => string): Promise<void> {
  const file = await pickFile('.json,application/json');
  if (!file) return;
  try {
    if (file.size > 16 * 1024 * 1024) throw new Error('Import exceeds 16 MiB. Split the import into reviewed batches.');
    const parsed = JSON.parse(await file.text()) as unknown;
    const docs = Array.isArray(parsed) ? parsed : [parsed];
    const res = await api.runCommand(cid, {
      kind: 'document',
      op: 'insertMany',
      collection: node.table ?? node.name ?? node.label,
      payload: { database: node.database, documents: docs },
    });
    toast.success(t('node.importDone', { n: res.rowCount }));
  } catch (e) {
    toast.error(t('node.importJson'), { description: e instanceof Error ? e.message : String(e) });
  }
}

/** Context-menu items per node kind (table/schema/etc). Empty for connection roots (they have a kebab). */
function buildNodeMenu(
  node: DbTreeNode,
  db: UseDbClient,
  t: (k: string, o?: Record<string, unknown>) => string,
): ContextMenuItem[] {
  const copyName: ContextMenuItem = {
    id: 'copy',
    label: t('node.copyName'),
    onSelect: () => void navigator.clipboard.writeText(node.name ?? node.table ?? node.label).catch(() => undefined),
  };
  if (node.kind === 'table' || node.kind === 'view') {
    const engine = db.connections.find((c) => c.id === node.connectionId)?.engine;
    const ek = engine ? engineKindFor(engine) : 'relational';
    // Document collections / key-value DBs only get "open" — the relational items
    // (structure, generate SQL, CSV, dump, truncate, drop) make no sense there.
    if (ek !== 'relational') {
      const ncid = db.connKeyFor(node.connectionId, node.database);
      return [
        { id: 'data', label: t('node.viewData'), onSelect: () => void db.openTableData(node) },
        ...(ek === 'document'
          ? [{ id: 'import-json', label: t('node.importJson'), separatorBefore: true, onSelect: () => void importJson(node, ncid, t) }]
          : []),
        { id: 'refresh', label: t('node.refresh'), separatorBefore: true, onSelect: () => db.refreshNode(node.id) },
        copyName,
      ];
    }
    const cid = db.connKeyFor(node.connectionId, node.database);
    const tbl = node.table ?? '';
    return [
      { id: 'data', label: t('node.viewData'), onSelect: () => void db.openTableData(node) },
      { id: 'structure', label: t('node.editStructure'), onSelect: () => void db.openStructureTab(node) },
      { id: 'query', label: t('node.newQuery'), onSelect: () => db.openQueryTab(node.connectionId, node.schema, undefined, node.database) },
      {
        id: 'gen-select',
        label: t('node.genSelect'),
        separatorBefore: true,
        onSelect: async () => {
          const { sql } = await api.generateSql(cid, node.schema, tbl, 'select');
          db.openQueryTab(node.connectionId, node.schema, sql, node.database);
        },
      },
      {
        id: 'gen-insert',
        label: t('node.genInsert'),
        onSelect: async () => {
          const { sql } = await api.generateSql(cid, node.schema, tbl, 'insert');
          db.openQueryTab(node.connectionId, node.schema, sql, node.database);
        },
      },
      {
        id: 'copy-ddl',
        label: t('node.copyDdl'),
        onSelect: async () => {
          const { sql } = await api.generateSql(cid, node.schema, tbl, 'create');
          if (await copyText(sql)) toast.success(t('node.ddlCopied'));
        },
      },
      copyName,
      {
        id: 'import-csv',
        label: t('node.importCsv'),
        onSelect: () => db.requestImportCsv(node),
      },
      {
        id: 'dump-sql',
        label: t('node.dumpSql'),
        onSelect: () => void exportTable(node, cid, db, 'sql', t),
      },
      {
        id: 'export-csv',
        label: t('node.exportCsv'),
        onSelect: () => void exportTable(node, cid, db, 'csv', t),
      },
      {
        id: 'rename',
        label: t('node.rename'),
        separatorBefore: true,
        onSelect: async () => {
          const to = await prompt({ title: t('node.rename'), placeholder: t('node.renamePrompt'), defaultValue: tbl });
          if (!to?.trim() || to.trim() === tbl) return;
          try {
            await api.ddl({ connectionId: cid, op: 'alter', spec: { alter: { schema: node.schema, table: tbl, actions: [{ kind: 'renameTable', to: to.trim() }] } } });
            db.invalidateTables(node.connectionId, node.schema);
          } catch (e) {
            toast.error(t('node.rename'), { description: e instanceof Error ? e.message : String(e) });
          }
        },
      },
      {
        id: 'truncate',
        label: t('node.truncate'),
        destructive: true,
        onSelect: async () => {
          if (!(await confirm({ title: t('node.truncate'), description: t('node.truncateConfirm', { name: tbl }), tone: 'destructive' }))) return;
          try {
            const { sql } = await api.generateSql(cid, node.schema, tbl, 'truncate');
            await api.runQuery(cid, sql, { schema: node.schema });
            toast.success(t('node.truncated'));
          } catch (e) {
            toast.error(t('node.truncate'), { description: e instanceof Error ? e.message : String(e) });
          }
        },
      },
      {
        id: 'drop',
        label: t('node.dropTable'),
        separatorBefore: true,
        destructive: true,
        onSelect: async () => {
          const name = node.table ?? node.label;
          if (!(await confirm({ title: t('node.dropConfirmTitle', { name }), description: t('node.dropConfirmBody'), tone: 'destructive' }))) return;
          try {
            await api.ddl({ connectionId: cid, op: 'drop', spec: { drop: { schema: node.schema, table: node.table ?? '' } } });
            db.invalidateTables(node.connectionId, node.schema);
          } catch (e) {
            toast.error(t('node.dropTable'), { description: e instanceof Error ? e.message : String(e) });
          }
        },
      },
    ];
  }
  if (node.kind === 'schema') {
    return [
      // Console scoped to this schema (pg search_path / mysql USE).
      { id: 'query', label: t('node.newQuery'), onSelect: () => db.openQueryTab(node.connectionId, node.schema, undefined, node.database) },
      { id: 'newtable', label: t('node.newTable'), onSelect: () => void db.openNewTable(node.connectionId, node.schema, node.database) },
      { id: 'er', label: t('node.erDiagram'), onSelect: () => void db.openErDiagram(node.connectionId, node.schema, node.database) },
      { id: 'schema-diff', label: t('node.schemaDiff'), onSelect: () => void db.openSchemaDiff(node.connectionId, node.schema, node.database) },
      { id: 'dump-schema', label: t('node.dumpSchema'), separatorBefore: true, onSelect: () => void dumpSchema(node, db.connKeyFor(node.connectionId, node.database), t) },
      { id: 'restore', label: t('node.restore'), onSelect: () => void restoreScript(node, db.connKeyFor(node.connectionId, node.database), db, t) },
      { id: 'refresh', label: t('node.refresh'), separatorBefore: true, onSelect: () => db.refreshNode(node.id) },
    ];
  }
  if (node.kind === 'database') {
    return [
      { id: 'query', label: t('node.newQuery'), onSelect: () => db.openQueryTab(node.connectionId, undefined, undefined, node.database) },
      { id: 'refresh', label: t('node.refresh'), onSelect: () => db.refreshNode(node.id) },
    ];
  }
  if (node.kind === 'group') {
    return [{ id: 'refresh', label: t('node.refresh'), onSelect: () => db.refreshNode(node.id) }];
  }
  if (
    node.kind === 'column' ||
    node.kind === 'index' ||
    node.kind === 'fk' ||
    node.kind === 'trigger' ||
    node.kind === 'function' ||
    node.kind === 'sequence'
  ) {
    return [copyName];
  }
  return [];
}

const STATUS_DOT: Record<DbConnectionStatus, string> = {
  idle: 'bg-muted-foreground/40',
  connecting: 'bg-amber-500 animate-pulse',
  connected: 'bg-emerald-500',
  error: 'bg-red-500',
};

function normalizeSearchText(value: unknown): string {
  return String(value ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

function nodeSearchText(node: DbTreeNode, conn?: DbConnection): string {
  return normalizeSearchText([
    node.kind,
    node.label,
    node.name,
    node.database,
    node.schema,
    node.table,
    node.groupKind,
    conn?.label,
    conn?.engine,
    conn?.database_name,
    conn?.group_name,
  ].filter(Boolean).join(' '));
}

type ConnectionTreeRenderItem =
  | { kind: 'node'; key: string; node: DbTreeNode }
  | { kind: 'group'; key: string; label: string }
  | { kind: 'schema-filter'; key: string; nodeId: string; depth: number; value: string };

/**
 * Build the exact flat sequence consumed by the virtualizer. Keeping group
 * headings and schema filters in the same sequence gives every visual row a
 * stable key and a deterministic height; expanded schemas with thousands of
 * tables no longer create thousands of mounted React nodes.
 */
export function buildConnectionTreeRenderItems({
  rows,
  connections,
  expanded,
  schemaFilters,
}: {
  rows: DbTreeNode[];
  connections: DbConnection[];
  expanded: ReadonlySet<string>;
  schemaFilters: Record<string, string>;
}): ConnectionTreeRenderItem[] {
  const items: ConnectionTreeRenderItem[] = [];
  const connectionById = new Map(connections.map((connection) => [connection.id, connection]));
  let lastGroup = '';
  let schemaContext: { id: string; query: string } | null = null;
  let hiddenPrefix: string | null = null;

  for (const node of rows) {
    if (hiddenPrefix && node.id.startsWith(`${hiddenPrefix}/`)) continue;
    hiddenPrefix = null;
    if (schemaContext && node.id !== schemaContext.id && !node.id.startsWith(`${schemaContext.id}/`)) {
      schemaContext = null;
    }

    if (node.depth === 0) {
      const group = connectionById.get(node.connectionId)?.group_name?.trim() ?? '';
      if (group && group !== lastGroup) {
        items.push({ kind: 'group', key: `group:${group}:${node.id}`, label: group });
      }
      lastGroup = group;
    }

    if (node.kind === 'schema') {
      items.push({ kind: 'node', key: node.id, node });
      if (expanded.has(node.id)) {
        // Annotated: without it TS reports TS7022 (circular inference through
        // the pushed union member) and silently widens the filter text to `any`.
        const value: string = schemaFilters[node.id] ?? '';
        schemaContext = { id: node.id, query: normalizeSearchText(value.trim()) };
        items.push({
          kind: 'schema-filter',
          key: `filter:${node.id}`,
          nodeId: node.id,
          depth: node.depth + 1,
          value,
        });
      } else {
        schemaContext = null;
      }
      continue;
    }

    if (schemaContext?.query && (node.kind === 'table' || node.kind === 'view')) {
      const name = normalizeSearchText(node.name ?? node.label);
      if (!name.includes(schemaContext.query)) {
        hiddenPrefix = node.id;
        continue;
      }
    }

    items.push({ kind: 'node', key: node.id, node });
  }

  return items;
}

function treeItemHeight(item: ConnectionTreeRenderItem): number {
  if (item.kind === 'group') return 26;
  if (item.kind === 'schema-filter') return 24;
  return 22;
}

function NodeIcon({ node }: { node: DbTreeNode }) {
  if (node.depth === 0) return <Database className="h-3.5 w-3.5 text-sky-500" />;
  switch (node.kind) {
    case 'database':
      return <Database className="h-3.5 w-3.5 text-muted-foreground" />;
    case 'schema':
      return <Box className="h-3.5 w-3.5 text-muted-foreground" />;
    case 'table':
      return <Table2 className="h-3.5 w-3.5 text-muted-foreground" />;
    case 'view':
      return <Eye className="h-3.5 w-3.5 text-muted-foreground" />;
    case 'group':
      return <Folder className="h-3.5 w-3.5 text-muted-foreground/70" />;
    case 'index':
      return <KeyRound className="h-3.5 w-3.5 text-violet-400/80" />;
    case 'fk':
      return <Link2 className="h-3.5 w-3.5 text-amber-400/80" />;
    case 'trigger':
      return <Zap className="h-3.5 w-3.5 text-rose-400/80" />;
    case 'function':
      return <Braces className="h-3.5 w-3.5 text-emerald-400/80" />;
    case 'sequence':
      return <Hash className="h-3.5 w-3.5 text-sky-400/80" />;
    default:
      return <Columns3 className="h-3.5 w-3.5 text-muted-foreground/70" />;
  }
}

export function ConnectionTree({
  db,
  onAdd,
  onEdit,
}: {
  db: UseDbClient;
  onAdd: () => void;
  onEdit: (conn: DbConnection) => void;
}) {
  const { t } = useTranslation('dbClient');
  const [filter, setFilter] = useState('');
  const [catalogRows, setCatalogRows] = useState<DbTreeNode[]>([]);
  const [catalogSearching, setCatalogSearching] = useState(false);
  const [catalogPartial, setCatalogPartial] = useState(false);
  // Per-schema table filter (keyed by the schema node id) — the input that
  // appears right above a schema's tables once it's expanded.
  const [schemaFilters, setSchemaFilters] = useState<Record<string, string>>({});
  // Filtering walks the whole expanded tree (normalizing every label). Deferring
  // it keeps typing at 60fps on a schema with thousands of tables: the input
  // updates immediately, the expensive re-filter lands on the next idle pass.
  const deferredFilter = useDeferredValue(filter);
  const deferredSchemaFilters = useDeferredValue(schemaFilters);

  useEffect(() => {
    const query = filter.trim();
    setCatalogPartial(false);
    if (query.length < 2) {
      setCatalogRows([]);
      setCatalogSearching(false);
      return;
    }
    const connected = db.connections.filter((connection) =>
      db.statusById[connection.id] === 'connected' && engineKindFor(connection.engine) === 'relational',
    );
    setCatalogRows([]);
    if (connected.length === 0) { setCatalogSearching(false); return; }
    let cancelled = false;
    const controller = new AbortController();
    setCatalogSearching(true);
    const timer = window.setTimeout(() => {
      // Limit physical catalogue requests; superseded searches release their drivers.
      const groups: Array<{ connection: typeof connected[number]; objects: Awaited<ReturnType<typeof api.searchCatalog>> }> = [];
      let next = 0, failedSources = 0;
      void Promise.all(Array.from({ length: Math.min(4, connected.length) }, async () => {
        while (!controller.signal.aborted && next < connected.length) {
          const connection = connected[next++];
          try {
            const objects = await api.searchCatalog(api.connectionKey(connection.project_id, connection.id), query, 100, controller.signal);
            groups.push({ connection, objects });
          } catch { if (!controller.signal.aborted) failedSources++; }
        }
      })).then(() => {
        if (cancelled) return;
        setCatalogPartial(failedSources > 0);
        setCatalogRows(groups.flatMap(({ connection, objects }) => objects.map((object) => ({
          id: `catalog:${connection.id}:${object.kind}:${object.schema ?? ''}:${object.name}`,
          kind: object.kind === 'function' ? 'function' as const
            : object.kind === 'sequence' ? 'sequence' as const
              : object.kind,
          label: object.schema && object.kind !== 'schema' ? `${object.schema}.${object.name}` : object.name,
          name: object.name,
          connectionId: connection.id,
          schema: object.kind === 'schema' ? object.name : object.schema,
          table: object.kind === 'table' || object.kind === 'view' ? object.name : undefined,
          depth: 1,
          expandable: object.kind === 'schema' || object.kind === 'table' || object.kind === 'view',
        }))));
      }).catch(() => {
        if (!cancelled) { setCatalogRows([]); setCatalogPartial(true); }
      }).finally(() => {
        if (!cancelled) setCatalogSearching(false);
      });
    }, 250);
    return () => {
      cancelled = true;
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [db.connections, db.statusById, filter]);

  const visibleRows = useMemo(() => {
    const q = normalizeSearchText(deferredFilter.trim());
    if (!q) return db.treeRows;
    if (catalogRows.length > 0) return catalogRows;

    const connById = new Map(db.connections.map((conn) => [conn.id, conn]));
    const parentById = new Map<string, string>();
    const stack: DbTreeNode[] = [];
    const matchingIds = new Set<string>();
    const includeIds = new Set<string>();

    for (const node of db.treeRows) {
      stack.length = node.depth;
      const parent = stack[stack.length - 1];
      if (parent) parentById.set(node.id, parent.id);
      stack.push(node);
    }

    const includeWithAncestors = (id: string) => {
      let current: string | undefined = id;
      while (current) {
        includeIds.add(current);
        current = parentById.get(current);
      }
    };

    for (const node of db.treeRows) {
      const haystack = nodeSearchText(node, connById.get(node.connectionId));
      if (!haystack.includes(q)) continue;
      matchingIds.add(node.id);
      includeWithAncestors(node.id);
    }

    if (matchingIds.size === 0) return [];

    for (const node of db.treeRows) {
      let current: string | undefined = node.id;
      while (current) {
        if (matchingIds.has(current)) {
          includeIds.add(node.id);
          break;
        }
        current = parentById.get(current);
      }
    }

    return db.treeRows.filter((row) => includeIds.has(row.id));
  }, [catalogRows, deferredFilter, db.treeRows, db.connections]);

  const renderItems = useMemo(
    () => buildConnectionTreeRenderItems({
      rows: visibleRows,
      connections: db.connections,
      expanded: db.expanded,
      schemaFilters: deferredSchemaFilters,
    }),
    [visibleRows, db.connections, db.expanded, deferredSchemaFilters],
  );
  const scrollRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: renderItems.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (index) => treeItemHeight(renderItems[index]!),
    getItemKey: (index) => renderItems[index]?.key ?? index,
    overscan: 14,
  });

  return (
    <div className="flex h-full flex-col bg-[var(--workbench-surface)]">
      <div className="flex items-center gap-1 border-b border-[var(--workbench-border)] bg-[var(--workbench-raised)] px-2 py-1.5">
        <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
          {t('connections.title')}
        </span>
        <div className="flex-1" />
        <button className="rounded p-1 hover:bg-muted" title={t('connections.refresh')} onClick={() => void db.refresh()}>
          <RefreshCw className="h-3.5 w-3.5" />
        </button>
        <button className="rounded p-1 hover:bg-muted" title={t('connections.add')} onClick={onAdd}>
          <Plus className="h-3.5 w-3.5" />
        </button>
      </div>

      <DatabaseJobProgress connectionIds={db.connections.map(connection => db.connKeyFor(connection.id))} />
      <div className="border-b px-2 py-1">
        <input
          className="h-6 w-full rounded border bg-background px-2 text-xs"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder={t('connections.search')}
        />
      </div>

      <div ref={scrollRef} className="min-h-0 flex-1 overflow-auto py-1">
        {db.connections.length === 0 && !db.loading && (
          <div className="px-3 py-6 text-center text-xs text-muted-foreground">{t('connections.empty')}</div>
        )}
        {catalogPartial && <div role="status" className="px-3 py-2 text-xs text-amber-600">{t('connections.partialSearch')}</div>}
        {deferredFilter.trim() && visibleRows.length === 0 && db.connections.length > 0 && !catalogSearching && !catalogPartial && (
          <div className="px-3 py-6 text-center text-xs text-muted-foreground">
            {t('connections.noSearchResults', { query: deferredFilter.trim() })}
          </div>
        )}
        {renderItems.length > 0 && (
          <div className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
            {virtualizer.getVirtualItems().map((virtualRow) => {
              const item = renderItems[virtualRow.index];
              if (!item) return null;
              return (
                <div
                  key={item.key}
                  className="absolute left-0 top-0 w-full"
                  style={{
                    height: virtualRow.size,
                    transform: `translateY(${virtualRow.start}px)`,
                  }}
                >
                  {item.kind === 'group' ? (
                    <div className="flex h-[26px] items-end px-3 pb-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground/50">
                      {item.label}
                    </div>
                  ) : item.kind === 'schema-filter' ? (
                    <SchemaFilterRow
                      value={item.value}
                      depth={item.depth}
                      placeholder={t('tree.filterTables')}
                      onChange={(value) => setSchemaFilters((state) => ({ ...state, [item.nodeId]: value }))}
                    />
                  ) : (
                    <Row node={item.node} db={db} t={t} onEdit={onEdit} />
                  )}
                </div>
              );
            })}
          </div>
        )}
        {catalogSearching && visibleRows.length === 0 && (
          <div className="flex items-center justify-center gap-2 px-3 py-6 text-xs text-muted-foreground">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            {t('tree.searchingCatalog')}
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * Quick table filter rendered just above a schema's tables once it's expanded.
 *
 * Holds its own draft: the parent's copy is deferred (it drives a whole-tree
 * re-filter), and binding the input straight to that made every keystroke wait
 * for the filtering pass before the character appeared.
 */
function SchemaFilterRow({
  value,
  onChange,
  depth,
  placeholder,
}: {
  value: string;
  onChange: (v: string) => void;
  depth: number;
  placeholder: string;
}) {
  const [draft, setDraft] = useState(value);
  const committed = useRef(value);
  // Re-sync only when the parent's value moved on its own (row recycled by the
  // virtualizer), never when it's just catching up to what we already typed.
  if (value !== committed.current && value !== draft) {
    committed.current = value;
    setDraft(value);
  }

  return (
    <div className="flex h-6 items-center" style={{ paddingLeft: 4 + depth * 12 }} onClick={(e) => e.stopPropagation()}>
      <Search className="mr-1 h-3 w-3 shrink-0 text-muted-foreground/50" />
      <input
        className="h-5 w-[80%] rounded border bg-background px-1.5 text-[11px] outline-none"
        value={draft}
        placeholder={placeholder}
        onChange={(e) => {
          committed.current = e.target.value;
          setDraft(e.target.value);
          onChange(e.target.value);
        }}
      />
    </div>
  );
}

function Row({
  node,
  db,
  t,
  onEdit,
}: {
  node: DbTreeNode;
  db: UseDbClient;
  t: (k: string, o?: Record<string, unknown>) => string;
  onEdit: (conn: DbConnection) => void;
}) {
  const isOpen = db.expanded.has(node.id);
  const isLoading = db.loadingNodes.has(node.id);
  const conn = node.depth === 0 ? db.connections.find((c) => c.id === node.connectionId) ?? null : null;
  const status = conn ? db.statusById[conn.id] ?? 'idle' : 'idle';
  const menuItems = buildNodeMenu(node, db, t);
  const { triggerProps, Menu } = useContextMenu(menuItems);

  return (
    <>
    <div
      className="group flex h-[22px] cursor-pointer items-center gap-1 pr-1 text-xs hover:bg-muted/60"
      style={{ paddingLeft: 4 + node.depth * 12, ...(conn?.color ? { boxShadow: `inset 3px 0 0 ${conn.color}` } : {}) }}
      {...(menuItems.length > 0 ? triggerProps : {})}
      onClick={() => void db.toggleExpand(node)}
      onDoubleClick={() => {
        if (node.kind === 'table' || node.kind === 'view') void db.openTableData(node);
        else if (node.depth === 0) db.selectConnection(node.connectionId);
      }}
    >
      <span className="flex h-4 w-4 items-center justify-center">
        {node.expandable ? (
          isLoading ? (
            <Loader2 className="h-3 w-3 animate-spin" />
          ) : isOpen ? (
            <ChevronDown className="h-3 w-3" />
          ) : (
            <ChevronRight className="h-3 w-3" />
          )
        ) : null}
      </span>
      <NodeIcon node={node} />
      {node.depth === 0 && <span className={`h-1.5 w-1.5 rounded-full ${STATUS_DOT[status]}`} />}
      <span className="flex-1 truncate" title={node.label}>
        {node.kind === 'group' && node.groupKind ? t(`node.group.${node.groupKind}`) : node.label}
      </span>

      {conn && (
        <div onClick={(e) => e.stopPropagation()}>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button className="rounded p-0.5 opacity-0 hover:bg-muted group-hover:opacity-100" title="…">
                <MoreVertical className="h-3.5 w-3.5" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="text-xs">
              {status === 'connected' ? (
                <DropdownMenuItem onClick={() => void db.disconnectConn(conn)}>
                  <Plug className="mr-2 h-3.5 w-3.5" />
                  {t('connections.disconnect')}
                </DropdownMenuItem>
              ) : (
                <DropdownMenuItem onClick={() => void db.connectConn(conn)}>
                  <PlugZap className="mr-2 h-3.5 w-3.5" />
                  {t('connections.connect')}
                </DropdownMenuItem>
              )}
              <DropdownMenuItem
                onClick={async () => {
                  if (status !== 'connected') await db.connectConn(conn).catch(() => void 0);
                  db.openQueryTab(conn.id);
                }}
              >
                {t('connections.newQuery')}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => onEdit(conn)}>{t('connections.edit')}</DropdownMenuItem>
              <DropdownMenuItem
                onClick={async () => {
                  if (await confirm({ title: t('connections.deleteTitle'), description: t('connections.deleteBody'), tone: 'destructive' })) {
                    void db.removeConnection(conn);
                  }
                }}
              >
                {t('connections.delete')}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      )}
    </div>
    {menuItems.length > 0 && Menu}
    </>
  );
}
