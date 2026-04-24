import React from 'react';
import type { TreeNode } from './useFileTree.js';
import { FileTreeNode } from './FileTreeNode.js';

interface Props {
  root: TreeNode | null;
  expanded: Set<string>;
  selectedPath: string | null;
  onToggle: (n: TreeNode) => void;
  onSelect: (n: TreeNode) => void;
  error: string | null;
}

export function FileTree({ root, expanded, selectedPath, onToggle, onSelect, error }: Props) {
  if (error) {
    return <div className="p-3 text-xs text-destructive">{error}</div>;
  }
  if (!root) {
    return <div className="p-3 text-xs text-muted-foreground">Carregando árvore…</div>;
  }
  return (
    <div className="overflow-y-auto h-full">
      {(root.children ?? []).map((c) => (
        <FileTreeNode
          key={c.path}
          node={c}
          depth={0}
          expanded={expanded}
          selectedPath={selectedPath}
          onToggle={onToggle}
          onSelect={onSelect}
        />
      ))}
    </div>
  );
}
