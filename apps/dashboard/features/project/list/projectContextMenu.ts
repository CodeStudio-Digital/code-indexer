/**
 * Shared context-menu item builder for ProjectCard and ProjectRow.
 *
 * Both layouts (cards grid + compact list) expose the same right-click
 * menu — "Open", "Open in new window", "Copy path", "Edit", etc. The
 * items are computed identically; the trigger element differs.
 *
 * "Open in new window" is conditional on `window.electronAPI.openInNewWindow`
 * being available — in a plain-browser dev session there is no Electron
 * main process to spawn a window, so we drop the item rather than show
 * a broken affordance.
 */
import { Copy, ExternalLink, FolderOpen, FolderSymlink, Pencil } from 'lucide-react';
import type { ContextMenuItem } from '../../../components/ui/context-menu.js';
import { toast } from '../../../components/ui/prompt-dialog.js';
import type { ProjectCardData } from './ProjectCard.js';

export interface BuildProjectMenuArgs {
  /** Only id/name/root_path are read — the title-bar switcher passes a
   *  lightweight `{id,name,root_path}` while the cards pass full data. */
  project: Pick<ProjectCardData, 'id' | 'name' | 'root_path'>;
  onSelect: () => void;
  onEdit: () => void;
  /**
   * Labels (i18n-resolved). Passed in so the builder stays a pure
   * helper without pulling react-i18next.
   */
  labels: {
    open: string;
    openInNewWindow: string;
    openInExplorer: string;
    copyPath: string;
    edit: string;
    copied: string;
  };
}

export function buildProjectContextMenuItems({
  project,
  onSelect,
  onEdit,
  labels,
}: BuildProjectMenuArgs): ContextMenuItem[] {
  const items: ContextMenuItem[] = [
    {
      id: 'open',
      label: labels.open,
      icon: FolderOpen,
      onSelect,
    },
  ];

  const electronAPI = typeof window !== 'undefined' ? window.electronAPI : undefined;
  if (electronAPI?.openInNewWindow) {
    items.push({
      id: 'open-new-window',
      label: labels.openInNewWindow,
      icon: ExternalLink,
      onSelect: () => {
        void electronAPI.openInNewWindow!(`/projects/${project.id}`, project.name);
      },
    });
  }

  // Reveal the project's folder in the OS file manager. Electron-only —
  // a plain-browser dev session can't open native file explorers.
  if (electronAPI?.openPath) {
    items.push({
      id: 'open-in-explorer',
      label: labels.openInExplorer,
      icon: FolderSymlink,
      separatorBefore: true,
      onSelect: () => {
        electronAPI.openPath!(project.root_path);
      },
    });
  }

  items.push({
    id: 'copy-path',
    label: labels.copyPath,
    icon: Copy,
    separatorBefore: true,
    onSelect: () => {
      void navigator.clipboard
        ?.writeText(project.root_path)
        .then(() => toast.info(labels.copied, { description: project.root_path }))
        .catch(() => {
          /* clipboard unavailable (no secure context / permission) — no-op */
        });
    },
  });

  items.push({
    id: 'edit',
    label: labels.edit,
    icon: Pencil,
    onSelect: onEdit,
  });

  return items;
}
