import React from 'react';
import { ChevronRight, ChevronDown, File as FileIcon, Folder, FolderOpen } from 'lucide-react';
import type { TreeNode } from './useFileTree.js';

interface Props {
  node: TreeNode;
  depth: number;
  expanded: Set<string>;
  selectedPath: string | null;
  onToggle: (n: TreeNode) => void;
  onSelect: (n: TreeNode) => void;
}

export function FileTreeNode({ node, depth, expanded, selectedPath, onToggle, onSelect }: Props) {
  const isOpen = expanded.has(node.path);
  const isSelected = selectedPath === node.path;

  const handleClick = () => {
    if (node.type === 'dir') onToggle(node);
    else onSelect(node);
  };

  return (
    <div>
      <button
        type="button"
        onClick={handleClick}
        className={
          'w-full flex items-center gap-1 px-1.5 py-0.5 text-xs hover:bg-muted/50 text-left ' +
          (isSelected ? 'bg-muted' : '')
        }
        style={{ paddingLeft: `${depth * 12 + 6}px` }}
      >
        {node.type === 'dir' ? (
          <>
            {isOpen ? <ChevronDown className="h-3 w-3 shrink-0" /> : <ChevronRight className="h-3 w-3 shrink-0" />}
            {isOpen ? <FolderOpen className="h-3.5 w-3.5 shrink-0 text-muted-foreground" /> : <Folder className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />}
          </>
        ) : (
          <>
            <span className="w-3" />
            <FileIcon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          </>
        )}
        <span className="truncate">{node.name}</span>
      </button>
      {node.type === 'dir' && isOpen && node.children && (
        <div>
          {node.children.map((child) => (
            <FileTreeNode
              key={child.path}
              node={child}
              depth={depth + 1}
              expanded={expanded}
              selectedPath={selectedPath}
              onToggle={onToggle}
              onSelect={onSelect}
            />
          ))}
        </div>
      )}
    </div>
  );
}
