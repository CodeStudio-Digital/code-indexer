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
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as api from './api.js';
import { engineLabel, engineKindFor } from './engines.js';
import { preferredTreeName, restrictTreeNames } from './tree/tree-preferences.js';
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
  refresh: (changedConnectionId?: number) => Promise<void>;
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
  openNewTable: (connectionId: number, schema?: string, database?: string) => Promise<void>;
  /** Open an ER-diagram tab for a schema. */
  openErDiagram: (connectionId: number, schema?: string, database?: string) => Promise<void>;
  /** Compare a schema with another live connection/schema and generate a migration. */
  openSchemaDiff: (connectionId: number, schema?: string, database?: string) => Promise<void>;
  /** Live-op routing key for a node — `id`, or `id@db` for a dedicated catalog pool. */
  connKeyFor: (connectionId: number, database?: string) => string;
  /** Pending "import CSV into this table" request (drives the import dialog). */
  importRequest: { connectionId: number; connKey: string; schema?: string; table: string } | null;
  /** Ask to import a CSV into a table node. */
  requestImportCsv: (node: DbTreeNode) => void;
  /** Dismiss the import dialog. */
  clearImportRequest: () => void;
  /** Refetch a node's children (after DDL/DML changed the schema). */
  refreshNode: (nodeId: string) => void;
  /** Invalidate cached tables under a connection/schema after a DDL change. */
  invalidateTables: (connectionId: number, schema?: string) => void;
  /** Bare table + column names already loaded for a connection — feeds SQL autocomplete. */
  treeSuggestions: (connectionId: number) => string[];
  // ─── Work-area tabs ──────────────────────────────────────────────────
  workTabs: WorkTab[];
  activeTabId: string | null;
  openQueryTab: (connectionId: number, schema?: string, initialSql?: string, database?: string) => void;
  activateTab: (id: string) => void;
  closeTab: (id: string) => void;
  reorderTab: (id: string, beforeId: string | null) => void;
}

export interface UseDbClientOptions {
  /** Mirrors a DB work item into the host IDE's editor tab strip. */
  onOpenWorkTab?: (tab: WorkTab) => void;
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

export function useDbClient(projectId: number, options: UseDbClientOptions = {}): UseDbClient {
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
  const [importRequest, setImportRequest] = useState<{ connectionId: number; connKey: string; schema?: string; table: string } | null>(null);

  const connectedRef = useRef<Set<number>>(new Set());
  /** Extra per-database pools (Postgres/SQL Server, keyed `id@db`). */
  const connectedDbPoolsRef = useRef<Set<string>>(new Set());
  const querySeqRef = useRef(0);
  const connectionsRef = useRef<DbConnection[]>([]);
  connectionsRef.current = connections;
  const onOpenWorkTabRef = useRef(options.onOpenWorkTab);
  onOpenWorkTabRef.current = options.onOpenWorkTab;

  const publishWorkTab = useCallback((tab: WorkTab) => {
    onOpenWorkTabRef.current?.(tab);
  }, []);

  const refresh = useCallback(async (changedConnectionId?: number) => {
    setLoading(true);
    try {
      const list = await api.listConnections(projectId);
      connectionsRef.current = list;
      if (changedConnectionId != null) {
        const root = `conn:${changedConnectionId}`;
        const extraKeys = [...connectedDbPoolsRef.current].filter(
          (key) => api.parseConnKey(key).id === changedConnectionId,
        );
        await Promise.all([
          api.disconnect(String(changedConnectionId)).catch(() => void 0),
          ...extraKeys.map((key) => api.disconnect(key).catch(() => void 0)),
        ]);
        connectedRef.current.delete(changedConnectionId);
        for (const key of extraKeys) connectedDbPoolsRef.current.delete(key);
        api.invalidateTableInfo();
        setStatusById((prev) => ({ ...prev, [changedConnectionId]: 'idle' }));
        setChildrenById((prev) => Object.fromEntries(
          Object.entries(prev).filter(([key]) => key !== root && !key.startsWith(`${root}/`)),
        ));
        setExpanded((prev) => new Set([...prev].filter((key) => key !== root && !key.startsWith(`${root}/`))));
        setLoadingNodes((prev) => new Set([...prev].filter((key) => key !== root && !key.startsWith(`${root}/`))));
        setWorkTabs((prev) => {
          const next = prev.filter((tab) => tab.connectionId !== changedConnectionId);
          setActiveTabId((active) =>
            active && next.some((tab) => tab.id === active) ? active : (next.at(-1)?.id ?? null),
          );
          return next;
        });
        setImportRequest((request) => request?.connectionId === changedConnectionId ? null : request);
      }
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
      for (const key of connectedDbPoolsRef.current) void api.disconnect(key);
      connectedRef.current.clear();
      connectedDbPoolsRef.current.clear();
    };
  }, []);

  // Auto-reconnect: let the api layer rebuild a connect spec from the saved row
  // (parsing an `id@db` catalog key) so a live op that lands on a vanished pool
  // reconnects + retries instead of failing with "not connected".
  useEffect(() => {
    api.setSpecResolver(async (cid) => {
      const { id, database } = api.parseConnKey(cid);
      const conn = connectionsRef.current.find((c) => c.id === id);
      return conn ? api.resolveSpec(conn, database) : null;
    });
    return () => api.setSpecResolver(null);
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
      // Drop any per-database pools opened under this connection.
      for (const key of [...connectedDbPoolsRef.current]) {
        if (api.parseConnKey(key).id === conn.id) {
          void api.disconnect(key).catch(() => void 0);
          connectedDbPoolsRef.current.delete(key);
        }
      }
      setStatus(conn.id, 'idle');
      // Collapse the whole subtree of this connection.
      setExpanded((prev) => {
        const next = new Set([...prev].filter((k) => !k.startsWith(`conn:${conn.id}`)));
        return next;
      });
    },
    [setStatus],
  );

  /** Routing key for a non-default database that requires its own pool. */
  const connKeyFor = useCallback((connectionId: number, database?: string): string => {
    const conn = connectionsRef.current.find((c) => c.id === connectionId);
    if (
      (conn?.engine === 'postgres' || conn?.engine === 'mssql') &&
      !api.isUrlMode(conn) &&
      database &&
      database !== conn.database_name
    ) {
      return `${connectionId}@${database}`;
    }
    return String(connectionId);
  }, []);

  /** Ensure the pool behind a routing key is live (connects a per-db pool lazily). */
  const ensureDbConnected = useCallback(
    async (connKey: string): Promise<boolean> => {
      const { id, database } = api.parseConnKey(connKey);
      const conn = connectionsRef.current.find((c) => c.id === id);
      if (!conn) return false;
      if (!database) {
        // Default database → the root pool (status-tracked).
        if (!connectedRef.current.has(conn.id)) {
          try {
            await connectConn(conn);
          } catch {
            return false;
          }
        }
        return true;
      }
      if (connectedDbPoolsRef.current.has(connKey)) return true;
      try {
        await api.connect(await api.resolveSpec(conn, database));
        connectedDbPoolsRef.current.add(connKey);
        return true;
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
        return false;
      }
    },
    [connectConn],
  );

  /**
   * Describe a table for the tree. Deduping/caching lives in `api.describeTable`
   * (shared with the grid, the SQL editor and the structure tab), so expanding a
   * table and then opening its data tab costs ONE introspection round trip.
   */
  const getTableInfo = useCallback(
    (connKey: string, schema: string | undefined, table: string): Promise<DbTableInfo> => {
      const engine = connectionsRef.current.find((c) => c.id === api.parseConnKey(connKey).id)?.engine;
      const fallbackSchema = engine === 'mssql' ? 'dbo' : engine === 'postgres' ? 'public' : '';
      return api.describeTable(connKey, schema ?? fallbackSchema, table);
    },
    [],
  );

  /** Fetch the children of a node (connect-aware, engine-aware). */
  const fetchChildren = useCallback(async (node: DbTreeNode): Promise<DbTreeNode[]> => {
    // Root lists databases on the root pool; deeper nodes route by `id@db` so a
    // non-default Postgres/SQL Server database hits its own pool.
    const cid = node.depth === 0 ? String(node.connectionId) : connKeyFor(node.connectionId, node.database);
    if (node.depth === 0) {
      // Connection root → databases. Postgres/SQL Server list every database
      // (each browsed through its own lazily-connected pool).
      const conn = connections.find((c) => c.id === node.connectionId);
      // Key-value (Redis): logical DBs ARE the browse unit — list them as leaf
      // "table" nodes (double-click → key browser), skipping the schema level.
      if (conn && engineKindFor(conn.engine) === 'keyvalue') {
        const dbs = await api.listDatabases(cid);
        return dbs.map((db) => ({
          id: `conn:${node.connectionId}/kvdb:${db}`,
          kind: 'table' as const,
          label: `DB ${db}`,
          name: `DB ${db}`,
          connectionId: node.connectionId,
          database: db,
          table: db,
          depth: 1,
          expandable: false,
        }));
      }
      // URL-mode Postgres/SQL Server can't switch db (the DSN fixes it) — expose ONLY the
      // connected database (database:undefined → routes to the root pool), so we
      // never render a sibling db node whose content/ops silently hit the URL's db.
      if ((conn?.engine === 'postgres' || conn?.engine === 'mssql') && api.isUrlMode(conn)) {
        return [{
          id: `conn:${node.connectionId}/db:default`,
          kind: 'database' as const,
          label: conn.database_name || conn.label,
          connectionId: node.connectionId,
          database: undefined,
          depth: 1,
          expandable: true,
        }];
      }
      // A configured database is a tree scope, not just a connection hint.
      // Avoid listing every catalog when the user explicitly selected one.
      const configuredDatabase = preferredTreeName(conn?.database_name);
      const dbs = configuredDatabase
        ? restrictTreeNames([], configuredDatabase)
        : await api.listDatabases(cid);
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
      // Document stores (Mongo) have no schema layer — list collections directly.
      const eng = connections.find((c) => c.id === node.connectionId)?.engine;
      if (eng && engineKindFor(eng) === 'document') {
        const res = await api.runCommand(cid, { kind: 'document', op: 'listCollections', payload: { database: node.database } });
        return res.rows.map((r) => ({
          id: `${node.id}/coll:${String(r.name)}`,
          kind: 'table' as const,
          label: String(r.name),
          name: String(r.name),
          connectionId: node.connectionId,
          database: node.database,
          table: String(r.name),
          depth: node.depth + 1,
          expandable: false,
        }));
      }
      // A non-default Postgres/SQL Server database needs its own pool before introspection.
      if (!(await ensureDbConnected(cid))) return [];
      const { schemas } = await api.introspect(cid, node.database);
      const conn = connections.find((c) => c.id === node.connectionId);
      const configuredSchema = preferredTreeName(conn ? api.parseConnOptions(conn).defaultSchema : undefined);
      return restrictTreeNames(schemas, configuredSchema).map((s) => ({
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
      if (engine === 'postgres' || engine === 'mysql' || engine === 'mariadb' || engine === 'mssql' || engine === 'oracle') {
        groups.push(groupNode(node, 'functions'));
      }
      if (engine === 'postgres' || engine === 'mssql' || engine === 'oracle') groups.push(groupNode(node, 'sequences'));
      return [...tableNodes, ...groups];
    }
    if (node.kind === 'table' || node.kind === 'view') {
      const info = await getTableInfo(cid, node.schema, node.table ?? '');
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
        const info = await getTableInfo(cid, node.schema, node.table ?? '');
        return (info.indexes ?? []).map((ix) =>
          leaf(node, 'index', ix.name, `${ix.name}${ix.unique ? ' (unique)' : ''}${ix.primary ? ' [PK]' : ''} (${ix.columns.join(', ')})`),
        );
      }
      if (node.groupKind === 'fks') {
        const info = await getTableInfo(cid, node.schema, node.table ?? '');
        return (info.foreignKeys ?? []).map((fk) =>
          leaf(node, 'fk', fk.name, `${fk.columns.join(', ')} → ${fk.refTable} (${fk.refColumns.join(', ')})`),
        );
      }
      const kind = node.groupKind === 'functions' ? 'function' : node.groupKind === 'sequences' ? 'sequence' : 'trigger';
      const names = await api.listObjects(cid, node.groupKind!, node.schema, node.table);
      return names.map((n) => leaf(node, kind, n, n));
    }
    return [];
  }, [connections, getTableInfo, connKeyFor, ensureDbConnected]);

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
      // Also drop this connection's lazily-opened Postgres per-database pools.
      for (const key of [...connectedDbPoolsRef.current]) {
        if (api.parseConnKey(key).id === conn.id) {
          void api.disconnect(key).catch(() => void 0);
          connectedDbPoolsRef.current.delete(key);
        }
      }
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

  const openQueryTab = useCallback((connectionId: number, schema?: string, initialSql?: string, database?: string) => {
    querySeqRef.current += 1;
    const id = `query:${connectionId}:${querySeqRef.current}:${Date.now()}`;
    const tab: WorkTab = { id, kind: 'query', title: '', connectionId, connKey: connKeyFor(connectionId, database), schema, initialSql, seq: querySeqRef.current };
    setWorkTabs((tabs) => [...tabs, tab]);
    setActiveTabId(id);
    setActiveConnectionId(connectionId);
    publishWorkTab(tab);
  }, [connKeyFor, publishWorkTab]);

  const openTableData = useCallback(
    async (node: DbTreeNode) => {
      if (node.kind !== 'table' && node.kind !== 'view') return;
      const connKey = connKeyFor(node.connectionId, node.database);
      if (!(await ensureDbConnected(connKey))) return;
      // Engine category drives which surface opens: document → JSON view,
      // key-value → key browser, relational → the editable grid.
      const eng = connectionsRef.current.find((c) => c.id === node.connectionId)?.engine;
      const ek = eng ? engineKindFor(eng) : 'relational';
      const prefix = ek === 'document' ? 'docs' : ek === 'keyvalue' ? 'kv' : 'data';
      const kind: WorkTab['kind'] = ek === 'document' ? 'documents' : ek === 'keyvalue' ? 'keyvalue' : 'data';
      const id = `${prefix}:${connKey}:${node.database ?? ''}:${node.schema ?? ''}:${node.table ?? ''}`;
      const tab: WorkTab = {
        id,
        kind,
        title: node.table ?? node.label,
        connectionId: node.connectionId,
        connKey,
        database: node.database,
        schema: node.schema,
        table: node.table,
      };
      setWorkTabs((tabs) => {
        if (tabs.some((t) => t.id === id)) return tabs;
        return [...tabs, tab];
      });
      setActiveTabId(id);
      setActiveConnectionId(node.connectionId);
      publishWorkTab(tab);
    },
    [connKeyFor, ensureDbConnected, publishWorkTab],
  );

  const openStructureTab = useCallback(
    async (node: DbTreeNode) => {
      if (node.kind !== 'table' && node.kind !== 'view') return;
      const connKey = connKeyFor(node.connectionId, node.database);
      if (!(await ensureDbConnected(connKey))) return;
      const id = `structure:${connKey}:${node.schema ?? ''}:${node.table ?? ''}`;
      const tab: WorkTab = { id, kind: 'structure', title: node.table ?? node.label, connectionId: node.connectionId, connKey, schema: node.schema, table: node.table };
      setWorkTabs((tabs) => {
        if (tabs.some((t) => t.id === id)) return tabs;
        return [...tabs, tab];
      });
      setActiveTabId(id);
      setActiveConnectionId(node.connectionId);
      publishWorkTab(tab);
    },
    [connKeyFor, ensureDbConnected, publishWorkTab],
  );

  const openNewTable = useCallback(
    async (connectionId: number, schema?: string, database?: string) => {
      const connKey = connKeyFor(connectionId, database);
      if (!(await ensureDbConnected(connKey))) return;
      const id = `structure:new:${connKey}:${schema ?? ''}:${Date.now()}`;
      const tab: WorkTab = { id, kind: 'structure', title: '', connectionId, connKey, schema, table: '' };
      setWorkTabs((tabs) => [...tabs, tab]);
      setActiveTabId(id);
      setActiveConnectionId(connectionId);
      publishWorkTab(tab);
    },
    [connKeyFor, ensureDbConnected, publishWorkTab],
  );

  const openErDiagram = useCallback(
    async (connectionId: number, schema?: string, database?: string) => {
      const connKey = connKeyFor(connectionId, database);
      if (!(await ensureDbConnected(connKey))) return;
      const id = `er:${connKey}:${schema ?? ''}`;
      const tab: WorkTab = { id, kind: 'er', title: `ER · ${schema ?? ''}`, connectionId, connKey, schema };
      setWorkTabs((tabs) => {
        if (tabs.some((t) => t.id === id)) return tabs;
        return [...tabs, tab];
      });
      setActiveTabId(id);
      setActiveConnectionId(connectionId);
      publishWorkTab(tab);
    },
    [connKeyFor, ensureDbConnected, publishWorkTab],
  );

  const openSchemaDiff = useCallback(
    async (connectionId: number, schema?: string, database?: string) => {
      const connKey = connKeyFor(connectionId, database);
      if (!(await ensureDbConnected(connKey))) return;
      const id = `schema-diff:${connKey}:${schema ?? ''}`;
      const tab: WorkTab = { id, kind: 'schema-diff', title: `Diff · ${schema ?? ''}`, connectionId, connKey, schema };
      setWorkTabs((tabs) => (tabs.some((item) => item.id === id) ? tabs : [...tabs, tab]));
      setActiveTabId(id);
      setActiveConnectionId(connectionId);
      publishWorkTab(tab);
    },
    [connKeyFor, ensureDbConnected, publishWorkTab],
  );

  const requestImportCsv = useCallback((node: DbTreeNode) => {
    if (!node.table) return;
    setImportRequest({ connectionId: node.connectionId, connKey: connKeyFor(node.connectionId, node.database), schema: node.schema, table: node.table });
  }, [connKeyFor]);
  const clearImportRequest = useCallback(() => setImportRequest(null), []);

  const refreshNode = useCallback((nodeId: string) => {
    api.invalidateTableInfo();
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
    api.invalidateTableInfo();
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
  //
  // Memoized on purpose: this walks EVERY expanded node, and the consumer
  // (ConnectionTree) memoizes its filtering + virtual-item building on the
  // array identity. Rebuilding it on each render — a keystroke in the search
  // box, a status dot flipping — re-walked a schema with thousands of tables
  // and invalidated both downstream memos every time.
  const treeRows = useMemo<DbTreeNode[]>(() => {
    const rows: DbTreeNode[] = [];
    const pushSubtree = (node: DbTreeNode): void => {
      rows.push(node);
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
    return rows;
  }, [childrenById, connections, expanded]);

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
    openSchemaDiff,
    connKeyFor,
    importRequest,
    requestImportCsv,
    clearImportRequest,
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
