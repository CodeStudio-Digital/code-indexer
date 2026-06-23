/**
 * DriveFileTree — folder-grouped, collapsible renderer for the company
 * Drive panel. Replaces the old flat `<ul>` list. Folders collapse by
 * default for visibility; while a search is active (`forceOpen`) every
 * folder renders expanded so matches are never hidden.
 *
 * This file owns expansion state and builds the shared `DriveTreeCtx`;
 * the recursive row markup lives in DriveTreeRows.tsx.
 */
import React, { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { DriveTreeNode } from './driveTree.js';
import { TreeRows, type DriveTreeCtx } from './DriveTreeRows.js';

interface DriveFileTreeProps {
  nodes: DriveTreeNode[];
  /** When true (search active) all folders render expanded. */
  forceOpen: boolean;
  selectedPath: string | null;
  onOpen: (path: string) => void;
  onDelete: (path: string) => void;
  /** Delete a folder and every file under it. */
  onDeleteFolder: (node: Extract<DriveTreeNode, { type: 'dir' }>) => void;
}

export function DriveFileTree({
  nodes,
  forceOpen,
  selectedPath,
  onOpen,
  onDelete,
  onDeleteFolder,
}: DriveFileTreeProps) {
  const { t } = useTranslation('agents');
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());

  const toggle = useCallback((path: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }, []);

  const ctx: DriveTreeCtx = {
    expanded,
    forceOpen,
    selectedPath,
    toggle,
    onOpen,
    onDelete,
    onDeleteFolder,
    deleteLabel: t('common.delete', 'Delete'),
    deleteFolderLabel: t('drive.deleteFolder', 'Delete folder and all files inside'),
    copyLabel: t('drive.copyPath', 'Copy full path'),
  };

  return <TreeRows nodes={nodes} depth={0} ctx={ctx} />;
}
