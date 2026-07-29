import { useCallback, useEffect, useState } from 'react';
import { workspaceApi, type TreeEntry } from '../api.js';

export interface TreeNode {
  name: string;
  type: 'file' | 'dir';
  path: string;
  size: number | null;
  children?: TreeNode[];
  loading?: boolean;
  error?: string | null;
}

/**
 * Stateful tree for FilesTab. Loads root on mount and each directory
 * on-demand (when the user expands it). Keeps expansion state + cached
 * children per node so collapsing/expanding doesn't refetch.
 */
export function useFileTree(sessionId: string, projectId: number | null) {
  const [root, setRoot] = useState<TreeNode | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set(['.']));
  const [error, setError] = useState<string | null>(null);

  const loadChildren = useCallback(
    async (path: string): Promise<TreeEntry[] | null> => {
      if (projectId == null) return null;
      try {
        const r = await workspaceApi.tree(sessionId, projectId, path);
        return r.entries;
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
        return null;
      }
    },
    [sessionId, projectId],
  );

  // (re)load root on project change
  useEffect(() => {
    if (projectId == null) {
      setRoot(null);
      return;
    }
    let cancelled = false;
    setError(null);
    loadChildren('.').then((entries) => {
      if (cancelled || !entries) return;
      setRoot({
        name: '/',
        type: 'dir',
        path: '.',
        size: null,
        children: entries.map(toNode('.')),
      });
      setExpanded(new Set(['.']));
    });
    return () => { cancelled = true; };
  }, [projectId, loadChildren]);

  const toggle = useCallback(
    async (node: TreeNode) => {
      const isOpen = expanded.has(node.path);
      const next = new Set(expanded);
      if (isOpen) {
        next.delete(node.path);
        setExpanded(next);
        return;
      }
      next.add(node.path);
      setExpanded(next);
      if (node.children == null) {
        const entries = await loadChildren(node.path);
        if (entries) {
          setRoot((prev) => prev && assignChildren(prev, node.path, entries.map(toNode(node.path))));
        }
      }
    },
    [expanded, loadChildren],
  );

  return { root, expanded, toggle, error };
}

function toNode(parentPath: string) {
  return (e: TreeEntry): TreeNode => ({
    name: e.name,
    type: e.type,
    path: parentPath === '.' ? e.name : `${parentPath}/${e.name}`,
    size: e.size,
  });
}

/** Immutable update: find node with matching path and set its children. */
function assignChildren(node: TreeNode, path: string, children: TreeNode[]): TreeNode {
  if (node.path === path) return { ...node, children };
  if (!node.children) return node;
  return { ...node, children: node.children.map((c) => assignChildren(c, path, children)) };
}
