/**
 * Left-rail connection tree. Saved connections are roots; expanding one connects
 * (if needed) and lazily fetches databases → schemas → tables → columns. Each
 * level fetches its children on first expand and shows a per-node spinner.
 */
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  ChevronRight, ChevronDown, Database, Table2, Eye, Columns3, Box, Loader2,
  Plus, RefreshCw, MoreVertical, Plug, PlugZap, Folder, KeyRound, Link2, Zap, Braces, Hash,
} from 'lucide-react';
import {
  DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem,
} from '../../../components/ui/dropdown-menu.js';
import { confirm, prompt, toast } from '../../../components/ui/prompt-dialog.js';
import { useContextMenu, type ContextMenuItem } from '../../../components/ui/context-menu.js';
import { copyText } from '../../../lib/clipboard.js';
import * as api from '../api.js';
import type { UseDbClient } from '../useDbClient.js';
import type { DbConnection, DbConnectionStatus, DbTreeNode } from '../types.js';

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
    const cid = String(node.connectionId);
    const tbl = node.table ?? '';
    return [
      { id: 'data', label: t('node.viewData'), onSelect: () => void db.openTableData(node) },
      { id: 'structure', label: t('node.editStructure'), onSelect: () => void db.openStructureTab(node) },
      { id: 'query', label: t('node.newQuery'), onSelect: () => db.openQueryTab(node.connectionId) },
      {
        id: 'gen-select',
        label: t('node.genSelect'),
        separatorBefore: true,
        onSelect: async () => {
          const { sql } = await api.generateSql(cid, node.schema, tbl, 'select');
          db.openQueryTab(node.connectionId, node.schema, sql);
        },
      },
      {
        id: 'gen-insert',
        label: t('node.genInsert'),
        onSelect: async () => {
          const { sql } = await api.generateSql(cid, node.schema, tbl, 'insert');
          db.openQueryTab(node.connectionId, node.schema, sql);
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
            await api.ddl({ connectionId: String(node.connectionId), op: 'drop', spec: { drop: { schema: node.schema, table: node.table ?? '' } } });
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
      { id: 'query', label: t('node.newQuery'), onSelect: () => db.openQueryTab(node.connectionId, node.schema) },
      { id: 'newtable', label: t('node.newTable'), onSelect: () => void db.openNewTable(node.connectionId, node.schema) },
      { id: 'er', label: t('node.erDiagram'), onSelect: () => void db.openErDiagram(node.connectionId, node.schema) },
      { id: 'refresh', label: t('node.refresh'), onSelect: () => db.refreshNode(node.id) },
    ];
  }
  if (node.kind === 'database') {
    return [
      { id: 'query', label: t('node.newQuery'), onSelect: () => db.openQueryTab(node.connectionId) },
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

  const visibleRows = useMemo(() => {
    if (!filter.trim()) return db.treeRows;
    const q = filter.toLowerCase();
    // Filter on the root connection label; keep a root + its expanded children.
    const keepConn = new Set(
      db.connections.filter((c) => c.label.toLowerCase().includes(q)).map((c) => c.id),
    );
    return db.treeRows.filter((r) => keepConn.has(r.connectionId));
  }, [filter, db.treeRows, db.connections]);

  return (
    <div className="flex h-full flex-col bg-card">
      <div className="flex items-center gap-1 border-b px-2 py-1.5">
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

      <div className="border-b px-2 py-1">
        <input
          className="h-6 w-full rounded border bg-background px-2 text-xs"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder={t('connections.search')}
        />
      </div>

      <div className="flex-1 overflow-auto py-1">
        {db.connections.length === 0 && !db.loading && (
          <div className="px-3 py-6 text-center text-xs text-muted-foreground">{t('connections.empty')}</div>
        )}
        {(() => {
          const els: React.ReactNode[] = [];
          let lastGroup = '';
          for (const node of visibleRows) {
            if (node.depth === 0) {
              const g = db.connections.find((c) => c.id === node.connectionId)?.group_name?.trim() ?? '';
              if (g && g !== lastGroup) {
                els.push(
                  <div key={`grp:${g}`} className="px-3 pb-0.5 pt-2 text-[10px] font-medium uppercase tracking-wide text-muted-foreground/50">
                    {g}
                  </div>,
                );
              }
              lastGroup = g;
            }
            els.push(<Row key={node.id} node={node} db={db} t={t} onEdit={onEdit} />);
          }
          return els;
        })()}
      </div>
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
