/**
 * Master hook for the database client. Self-contained (no global store) so two
 * mounts can't leak — mirrors `useApiClient`. Owns: saved connections, per-
 * connection live status, a lazily-filled introspection tree, the active
 * connection for the query console, and query execution/cancel.
 *
 * Live sessions are torn down on unmount (project switch remounts via
 * `key={projectId}` in TransientSurface), so a connection never bleeds across
 * projects.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import * as api from './api.js';
import { engineLabel } from './engines.js';
import type { DbConnection, DbConnectionStatus, DbTableInfo, DbTreeGroupKind, DbTreeNode, WorkTab } from './types.js';

export interface UseDbClient {
  connections: DbConnection[];
  loading: boolean;
  error: string | null;
  statusById: Record<number, DbConnectionStatus>;
  /** Flattened, ordered tree rows (roots + expanded children). */
  treeRows: DbTreeNode[];
  expanded: Set<string>;
  loadingNodes: Set<string>;
  activeConnectionId: number | null;
  refresh: () => Promise<void>;
  connectConn: (conn: DbConnection) => Promise<void>;
  disconnectConn: (conn: DbConnection) => Promise<void>;
  toggleExpand: (node: DbTreeNode) => Promise<void>;
  selectConnection: (connectionId: number) => void;
  removeConnection: (conn: DbConnection) => Promise<void>;
  /** Open a table's data tab (double-click); connects the owning connection if needed. */
  openTableData: (node: DbTreeNode) => Promise<void>;
  /** Open a table's structure editor tab. */
  openStructureTab: (node: DbTreeNode) => Promise<void>;
  /** Open a blank "create table" structure tab for a connection/schema. */
  openNewTable: (connectionId: number, schema?: string) => Promise<void>;
  /** Open an ER-diagram tab for a schema. */
  openErDiagram: (connectionId: number, schema?: string) => Promise<void>;
  /** Refetch a node's children (after DDL/DML changed the schema). */
  refreshNode: (nodeId: string) => void;
  /** Invalidate cached tables under a connection/schema after a DDL change. */
  invalidateTables: (connectionId: number, schema?: string) => void;
  /** Bare table + column names already loaded for a connection — feeds SQL autocomplete. */
  treeSuggestions: (connectionId: number) => string[];
  // ─── Work-area tabs ──────────────────────────────────────────────────
  workTabs: WorkTab[];
  activeTabId: string | null;
  openQueryTab: (connectionId: number, schema?: string, initialSql?: string) => void;
  activateTab: (id: string) => void;
  closeTab: (id: string) => void;
  reorderTab: (id: string, beforeId: string | null) => void;
}

function connNode(conn: DbConnection): DbTreeNode {
  return {
    id: `conn:${conn.id}`,
    kind: 'database', // placeholder; rendered specially as the root
    label: conn.label,
    connectionId: conn.id,
    depth: 0,
    expandable: true,
  };
}

/** A folder node (Indexes / Foreign keys / Triggers / Functions / Sequences). */
function groupNode(parent: DbTreeNode, groupKind: DbTreeGroupKind): DbTreeNode {
  return {
    id: `${parent.id}/grp:${groupKind}`,
    kind: 'group',
    groupKind,
    label: groupKind, // display label is localized in the tree row via t()
    connectionId: parent.connectionId,
    database: parent.database,
    schema: parent.schema,
    table: parent.table,
    depth: parent.depth + 1,
    expandable: true,
  };
}

/** A leaf node (index / fk / trigger / function / sequence). */
function leaf(parent: DbTreeNode, kind: DbTreeNode['kind'], name: string, label: string): DbTreeNode {
  return {
    id: `${parent.id}/${kind}:${name}`,
    kind,
    label,
    name,
    connectionId: parent.connectionId,
    database: parent.database,
    schema: parent.schema,
    table: parent.table,
    depth: parent.depth + 1,
    expandable: false,
  };
}

export function useDbClient(projectId: number): UseDbClient {
  const [connections, setConnections] = useState<DbConnection[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [statusById, setStatusById] = useState<Record<number, DbConnectionStatus>>({});
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [loadingNodes, setLoadingNodes] = useState<Set<string>>(new Set());
  const [childrenById, setChildrenById] = useState<Record<string, DbTreeNode[]>>({});
  const [activeConnectionId, setActiveConnectionId] = useState<number | null>(null);
  const [workTabs, setWorkTabs] = useState<WorkTab[]>([]);
  const [activeTabId, setActiveTabId] = useState<string | null>(null);

  const connectedRef = useRef<Set<number>>(new Set());
  const querySeqRef = useRef(0);
  /** Cache TableInfo so columns + Indexes + FKs folders don't each refetch. */
  const tableInfoRef = useRef<Map<string, DbTableInfo>>(new Map());

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const list = await api.listConnections(projectId);
      setConnections(list);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Tear down all live sessions when the feature unmounts (project switch).
  useEffect(() => {
    return () => {
      for (const id of connectedRef.current) void api.disconnect(String(id));
      connectedRef.current.clear();
    };
  }, []);

  const setStatus = useCallback((id: number, status: DbConnectionStatus) => {
    setStatusById((prev) => ({ ...prev, [id]: status }));
  }, []);

  const markLoadingNode = useCallback((id: string, on: boolean) => {
    setLoadingNodes((prev) => {
      const next = new Set(prev);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  }, []);

  const connectConn = useCallback(
    async (conn: DbConnection) => {
      setStatus(conn.id, 'connecting');
      try {
        const spec = await api.resolveSpec(conn);
        await api.connect(spec);
        connectedRef.current.add(conn.id);
        setStatus(conn.id, 'connected');
        setActiveConnectionId(conn.id);
        void api.touchConnection(projectId, conn.id).catch(() => void 0);
      } catch (e) {
        setStatus(conn.id, 'error');
        setError(e instanceof Error ? e.message : String(e));
        throw e;
      }
    },
    [projectId, setStatus],
  );

  const disconnectConn = useCallback(
    async (conn: DbConnection) => {
      await api.disconnect(String(conn.id)).catch(() => void 0);
      connectedRef.current.delete(conn.id);
      setStatus(conn.id, 'idle');
      // Collapse the whole subtree of this connection.
      setExpanded((prev) => {
        const next = new Set([...prev].filter((k) => !k.startsWith(`conn:${conn.id}`)));
        return next;
      });
    },
    [setStatus],
  );

  /** Describe a table, memoized so columns + index/FK folders don't each refetch. */
  const getTableInfo = useCallback(
    async (connId: number, schema: string | undefined, table: string): Promise<DbTableInfo> => {
      const key = `${connId}:${schema ?? ''}:${table}`;
      const cached = tableInfoRef.current.get(key);
      if (cached) return cached;
      const info = await api.describeTable(String(connId), schema ?? 'public', table);
      tableInfoRef.current.set(key, info);
      return info;
    },
    [],
  );

  /** Fetch the children of a node (connect-aware, engine-aware). */
  const fetchChildren = useCallback(async (node: DbTreeNode): Promise<DbTreeNode[]> => {
    const cid = String(node.connectionId);
    if (node.depth === 0) {
      // Connection root → databases.
      const conn = connections.find((c) => c.id === node.connectionId);
      let dbs = await api.listDatabases(cid);
      // Postgres binds a connection to ONE database; switching needs a new
      // connection. Show only the connected db so the tree never lists databases
      // whose schemas it can't actually browse. (Multi-db = a connection each.)
      if (conn?.engine === 'postgres' && conn.database_name) {
        dbs = [conn.database_name];
      }
      return dbs.map((db) => ({
        id: `conn:${node.connectionId}/db:${db}`,
        kind: 'database' as const,
        label: db,
        connectionId: node.connectionId,
        database: db,
        depth: 1,
        expandable: true,
      }));
    }
    if (node.kind === 'database') {
      const { schemas } = await api.introspect(cid, node.database);
      return schemas.map((s) => ({
        id: `${node.id}/schema:${s}`,
        kind: 'schema' as const,
        label: s,
        connectionId: node.connectionId,
        database: node.database,
        schema: s,
        depth: node.depth + 1,
        expandable: true,
      }));
    }
    if (node.kind === 'schema') {
      const { tables } = await api.introspect(cid, node.database, node.schema);
      const tableNodes: DbTreeNode[] = tables.map((t) => ({
        id: `${node.id}/table:${t.name}`,
        kind: t.kind === 'view' ? ('view' as const) : ('table' as const),
        label: t.name,
        name: t.name,
        connectionId: node.connectionId,
        database: node.database,
        schema: t.schema,
        table: t.name,
        depth: node.depth + 1,
        expandable: true,
      }));
      const engine = connections.find((c) => c.id === node.connectionId)?.engine;
      const groups: DbTreeNode[] = [];
      if (engine === 'postgres' || engine === 'mysql' || engine === 'mariadb') groups.push(groupNode(node, 'functions'));
      if (engine === 'postgres') groups.push(groupNode(node, 'sequences'));
      return [...tableNodes, ...groups];
    }
    if (node.kind === 'table' || node.kind === 'view') {
      const info = await getTableInfo(node.connectionId, node.schema, node.table ?? '');
      const colNodes: DbTreeNode[] = info.columns.map((c) => ({
        id: `${node.id}/col:${c.name}`,
        kind: 'column' as const,
        label: `${c.name} : ${c.dataType}${c.isPrimaryKey ? ' [PK]' : ''}${c.nullable ? '' : ' *'}`,
        name: c.name,
        connectionId: node.connectionId,
        database: node.database,
        schema: node.schema,
        table: node.table,
        depth: node.depth + 1,
        expandable: false,
      }));
      return [...colNodes, groupNode(node, 'indexes'), groupNode(node, 'fks'), groupNode(node, 'triggers')];
    }
    if (node.kind === 'group') {
      if (node.groupKind === 'indexes') {
        const info = await getTableInfo(node.connectionId, node.schema, node.table ?? '');
        return (info.indexes ?? []).map((ix) =>
          leaf(node, 'index', ix.name, `${ix.name}${ix.unique ? ' (unique)' : ''}${ix.primary ? ' [PK]' : ''} (${ix.columns.join(', ')})`),
        );
      }
      if (node.groupKind === 'fks') {
        const info = await getTableInfo(node.connectionId, node.schema, node.table ?? '');
        return (info.foreignKeys ?? []).map((fk) =>
          leaf(node, 'fk', fk.name, `${fk.columns.join(', ')} → ${fk.refTable} (${fk.refColumns.join(', ')})`),
        );
      }
      const kind = node.groupKind === 'functions' ? 'function' : node.groupKind === 'sequences' ? 'sequence' : 'trigger';
      const names = await api.listObjects(cid, node.groupKind!, node.schema, node.table);
      return names.map((n) => leaf(node, kind, n, n));
    }
    return [];
  }, [connections, getTableInfo]);

  const toggleExpand = useCallback(
    async (node: DbTreeNode) => {
      if (!node.expandable) return;
      if (expanded.has(node.id)) {
        setExpanded((prev) => {
          const next = new Set(prev);
          next.delete(node.id);
          return next;
        });
        return;
      }
      // Expanding a connection root requires a live session.
      if (node.depth === 0) {
        const conn = connections.find((c) => c.id === node.connectionId);
        if (conn && !connectedRef.current.has(conn.id)) {
          await connectConn(conn);
        }
        setActiveConnectionId(node.connectionId);
      }
      if (!childrenById[node.id]) {
        markLoadingNode(node.id, true);
        try {
          const kids = await fetchChildren(node);
          setChildrenById((prev) => ({ ...prev, [node.id]: kids }));
        } catch (e) {
          setError(e instanceof Error ? e.message : String(e));
          markLoadingNode(node.id, false);
          return;
        }
        markLoadingNode(node.id, false);
      }
      setExpanded((prev) => new Set(prev).add(node.id));
    },
    [expanded, childrenById, connections, connectConn, fetchChildren, markLoadingNode],
  );

  const removeConnection = useCallback(
    async (conn: DbConnection) => {
      await api.disconnect(String(conn.id)).catch(() => void 0);
      connectedRef.current.delete(conn.id);
      await api.deleteConnection(projectId, conn.id);
      if (activeConnectionId === conn.id) setActiveConnectionId(null);
      // Drop any open work tabs belonging to this connection.
      setWorkTabs((tabs) => {
        const next = tabs.filter((t) => t.connectionId !== conn.id);
        setActiveTabId((cur) => (next.some((t) => t.id === cur) ? cur : (next[next.length - 1]?.id ?? null)));
        return next;
      });
      await refresh();
    },
    [projectId, activeConnectionId, refresh],
  );

  const selectConnection = useCallback((id: number) => setActiveConnectionId(id), []);

  // ─── Work-area tabs ────────────────────────────────────────────────────
  const activateTab = useCallback((id: string) => {
    setActiveTabId(id);
    setWorkTabs((tabs) => {
      const tab = tabs.find((t) => t.id === id);
      if (tab) setActiveConnectionId(tab.connectionId);
      return tabs;
    });
  }, []);

  const openQueryTab = useCallback((connectionId: number, schema?: string, initialSql?: string) => {
    querySeqRef.current += 1;
    const id = `query:${connectionId}:${querySeqRef.current}:${Date.now()}`;
    const tab: WorkTab = { id, kind: 'query', title: '', connectionId, schema, initialSql, seq: querySeqRef.current };
    setWorkTabs((tabs) => [...tabs, tab]);
    setActiveTabId(id);
    setActiveConnectionId(connectionId);
  }, []);

  const openTableData = useCallback(
    async (node: DbTreeNode) => {
      if (node.kind !== 'table' && node.kind !== 'view') return;
      const conn = connections.find((c) => c.id === node.connectionId);
      if (conn && !connectedRef.current.has(conn.id)) {
        try {
          await connectConn(conn);
        } catch {
          return;
        }
      }
      const id = `data:${node.connectionId}:${node.schema ?? ''}:${node.table ?? ''}`;
      setWorkTabs((tabs) => {
        if (tabs.some((t) => t.id === id)) return tabs;
        return [
          ...tabs,
          {
            id,
            kind: 'data',
            title: node.table ?? node.label,
            connectionId: node.connectionId,
            schema: node.schema,
            table: node.table,
          },
        ];
      });
      setActiveTabId(id);
      setActiveConnectionId(node.connectionId);
    },
    [connections, connectConn],
  );

  const ensureConnected = useCallback(
    async (connectionId: number): Promise<boolean> => {
      const conn = connections.find((c) => c.id === connectionId);
      if (conn && !connectedRef.current.has(conn.id)) {
        try {
          await connectConn(conn);
        } catch {
          return false;
        }
      }
      return true;
    },
    [connections, connectConn],
  );

  const openStructureTab = useCallback(
    async (node: DbTreeNode) => {
      if (node.kind !== 'table' && node.kind !== 'view') return;
      if (!(await ensureConnected(node.connectionId))) return;
      const id = `structure:${node.connectionId}:${node.schema ?? ''}:${node.table ?? ''}`;
      setWorkTabs((tabs) => {
        if (tabs.some((t) => t.id === id)) return tabs;
        return [
          ...tabs,
          { id, kind: 'structure', title: node.table ?? node.label, connectionId: node.connectionId, schema: node.schema, table: node.table },
        ];
      });
      setActiveTabId(id);
      setActiveConnectionId(node.connectionId);
    },
    [ensureConnected],
  );

  const openNewTable = useCallback(
    async (connectionId: number, schema?: string) => {
      if (!(await ensureConnected(connectionId))) return;
      const id = `structure:new:${connectionId}:${schema ?? ''}:${Date.now()}`;
      setWorkTabs((tabs) => [
        ...tabs,
        { id, kind: 'structure', title: '', connectionId, schema, table: '' },
      ]);
      setActiveTabId(id);
      setActiveConnectionId(connectionId);
    },
    [ensureConnected],
  );

  const openErDiagram = useCallback(
    async (connectionId: number, schema?: string) => {
      if (!(await ensureConnected(connectionId))) return;
      const id = `er:${connectionId}:${schema ?? ''}`;
      setWorkTabs((tabs) => {
        if (tabs.some((t) => t.id === id)) return tabs;
        return [...tabs, { id, kind: 'er', title: `ER · ${schema ?? ''}`, connectionId, schema }];
      });
      setActiveTabId(id);
      setActiveConnectionId(connectionId);
    },
    [ensureConnected],
  );

  const refreshNode = useCallback((nodeId: string) => {
    tableInfoRef.current.clear();
    setChildrenById((prev) => {
      const next = { ...prev };
      // Drop the node's cached children + everything under it so the next
      // expand refetches (used after a DDL/DML change).
      for (const k of Object.keys(next)) if (k === nodeId || k.startsWith(`${nodeId}/`)) delete next[k];
      return next;
    });
    setExpanded((prev) => new Set([...prev].filter((k) => k !== nodeId && !k.startsWith(`${nodeId}/`))));
  }, []);

  const treeSuggestions = useCallback(
    (connectionId: number): string[] => {
      const names = new Set<string>();
      for (const kids of Object.values(childrenById)) {
        for (const n of kids) {
          if (n.connectionId === connectionId && n.name && (n.kind === 'table' || n.kind === 'view' || n.kind === 'column')) {
            names.add(n.name);
          }
        }
      }
      return [...names].sort();
    },
    [childrenById],
  );

  const invalidateTables = useCallback((connectionId: number, schema?: string) => {
    tableInfoRef.current.clear();
    const match = (k: string): boolean =>
      k.startsWith(`conn:${connectionId}`) && (!schema || k.endsWith(`schema:${schema}`));
    setChildrenById((prev) => {
      const next = { ...prev };
      for (const k of Object.keys(next)) if (match(k)) delete next[k];
      return next;
    });
    // Collapse the affected schema node(s) so a re-expand refetches the table list.
    setExpanded((prev) => new Set([...prev].filter((k) => !match(k))));
  }, []);

  const closeTab = useCallback((id: string) => {
    setWorkTabs((tabs) => {
      const idx = tabs.findIndex((t) => t.id === id);
      if (idx < 0) return tabs;
      const next = tabs.filter((t) => t.id !== id);
      setActiveTabId((cur) => {
        if (cur !== id) return cur;
        // Activate the neighbour (VS Code semantics): prefer the right, else left.
        const neighbour = next[idx] ?? next[idx - 1] ?? null;
        return neighbour?.id ?? null;
      });
      return next;
    });
  }, []);

  const reorderTab = useCallback((id: string, beforeId: string | null) => {
    setWorkTabs((tabs) => {
      const moving = tabs.find((t) => t.id === id);
      if (!moving) return tabs;
      const without = tabs.filter((t) => t.id !== id);
      if (beforeId == null) return [...without, moving];
      const at = without.findIndex((t) => t.id === beforeId);
      if (at < 0) return [...without, moving];
      return [...without.slice(0, at), moving, ...without.slice(at)];
    });
  }, []);

  // Flatten roots + expanded children into ordered rows.
  const treeRows: DbTreeNode[] = [];
  const pushSubtree = (node: DbTreeNode): void => {
    treeRows.push(node);
    if (expanded.has(node.id)) {
      for (const child of childrenById[node.id] ?? []) pushSubtree(child);
    }
  };
  // Group connections so same-group roots are adjacent (header rendered in the tree).
  const ordered = [...connections].sort(
    (a, b) => (a.group_name ?? '').localeCompare(b.group_name ?? '') || a.sort_order - b.sort_order || a.label.localeCompare(b.label),
  );
  for (const conn of ordered) {
    const root = connNode(conn);
    // Label the root with its engine so different engines are distinguishable.
    root.label = `${conn.label} · ${engineLabel(conn.engine)}`;
    pushSubtree(root);
  }

  return {
    connections,
    loading,
    error,
    statusById,
    treeRows,
    expanded,
    loadingNodes,
    activeConnectionId,
    refresh,
    connectConn,
    disconnectConn,
    toggleExpand,
    selectConnection,
    removeConnection,
    openTableData,
    openStructureTab,
    openNewTable,
    openErDiagram,
    refreshNode,
    invalidateTables,
    treeSuggestions,
    workTabs,
    activeTabId,
    openQueryTab,
    activateTab,
    closeTab,
    reorderTab,
  };
}
