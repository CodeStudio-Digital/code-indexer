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
import type { DbConnection, DbConnectionStatus, DbTreeNode } from './types.js';

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

export function useDbClient(projectId: number): UseDbClient {
  const [connections, setConnections] = useState<DbConnection[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [statusById, setStatusById] = useState<Record<number, DbConnectionStatus>>({});
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [loadingNodes, setLoadingNodes] = useState<Set<string>>(new Set());
  const [childrenById, setChildrenById] = useState<Record<string, DbTreeNode[]>>({});
  const [activeConnectionId, setActiveConnectionId] = useState<number | null>(null);

  const connectedRef = useRef<Set<number>>(new Set());

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

  /** Fetch the children of a node (connect-aware, engine-aware). */
  const fetchChildren = useCallback(async (node: DbTreeNode): Promise<DbTreeNode[]> => {
    const cid = String(node.connectionId);
    if (node.depth === 0) {
      // Connection root → databases.
      const dbs = await api.listDatabases(cid);
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
      return tables.map((t) => ({
        id: `${node.id}/table:${t.name}`,
        kind: t.kind === 'view' ? ('view' as const) : ('table' as const),
        label: t.name,
        connectionId: node.connectionId,
        database: node.database,
        schema: t.schema,
        table: t.name,
        depth: node.depth + 1,
        expandable: true,
      }));
    }
    if (node.kind === 'table' || node.kind === 'view') {
      const info = await api.describeTable(cid, node.schema ?? 'public', node.table ?? '');
      return info.columns.map((c) => ({
        id: `${node.id}/col:${c.name}`,
        kind: 'column' as const,
        label: `${c.name} : ${c.dataType}${c.isPrimaryKey ? ' [PK]' : ''}${c.nullable ? '' : ' *'}`,
        connectionId: node.connectionId,
        database: node.database,
        schema: node.schema,
        table: node.table,
        depth: node.depth + 1,
        expandable: false,
      }));
    }
    return [];
  }, []);

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
      await refresh();
    },
    [projectId, activeConnectionId, refresh],
  );

  const selectConnection = useCallback((id: number) => setActiveConnectionId(id), []);

  // Flatten roots + expanded children into ordered rows.
  const treeRows: DbTreeNode[] = [];
  const pushSubtree = (node: DbTreeNode): void => {
    treeRows.push(node);
    if (expanded.has(node.id)) {
      for (const child of childrenById[node.id] ?? []) pushSubtree(child);
    }
  };
  for (const conn of connections) {
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
  };
}
