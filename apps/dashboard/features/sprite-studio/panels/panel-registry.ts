/**
 * Studio panel registry — the seam future dockable panels plug into.
 *
 * CONTRACT (consumed by the orchestrator in SpriteStudioView):
 * - Every dockable panel declares { id, side, icon, titleKey, render }.
 * - `titleKey` is a key in the `spriteStudio` i18n namespace (the left rail
 *   button + PanelChrome title are translated by the consumer).
 * - `render(ctx)` returns the panel BODY only — chrome (the shared RailButton
 *   left rail + PanelChrome) is applied by the orchestrator, which also
 *   persists collapse state + the active left tab in sprite-studio-ui-state.
 * - EXCEPTION: the `library` entry renders null — LibraryPanel needs the
 *   full useSpriteStudio controller (assets, filters, selection, create),
 *   which is far richer than StudioPanelCtx, so the orchestrator keeps
 *   mounting LibraryPanel directly and uses this entry only for the tab
 *   strip (id + icon + title). New self-contained panels should render
 *   themselves here; controller-coupled ones may follow the library model.
 */
import { createElement, type ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';
import { Film, FolderTree, LayoutGrid } from 'lucide-react';
import { ProjectImagesPanel } from './ProjectImagesPanel.js';

export interface StudioPanelCtx {
  /** IDE project id of the open studio. */
  projectId: number;
}

export interface StudioPanelDef {
  id: string;
  side: 'left' | 'right' | 'bottom';
  icon: LucideIcon;
  titleKey: string;
  render: (ctx: StudioPanelCtx) => ReactNode;
}

export const STUDIO_PANELS: StudioPanelDef[] = [
  // Placeholder: body mounted directly by the orchestrator (see contract).
  { id: 'library', side: 'left', icon: LayoutGrid, titleKey: 'library.title', render: () => null },
  // Frames browser — also controller-coupled (active asset + animate bridge),
  // so the orchestrator mounts its body directly, same as library.
  { id: 'frames', side: 'left', icon: Film, titleKey: 'frames.title', render: () => null },
  {
    id: 'files',
    side: 'left',
    icon: FolderTree,
    titleKey: 'panels.files',
    render: (ctx) => createElement(ProjectImagesPanel, { projectId: ctx.projectId }),
  },
];

/** Panels docked to one side, in declaration order. */
export const panelsForSide = (side: StudioPanelDef['side']): StudioPanelDef[] =>
  STUDIO_PANELS.filter((p) => p.side === side);
