/**
 * Central registry of left-rail zone tabs.
 *
 * Owns the icon + i18n label for every Work / Build / Data tab so
 * `LeftTabRail` can render the full strip from a single source. Each
 * Zone component only resolves which body to mount for the active
 * `tab` value.
 *
 * Order in the array drives order in the rail; a separator is drawn
 * at every zone transition.
 *
 * NOTE: Inbox / Env / Databases live on the RIGHT rail
 * (`preview-sidebar/SidebarRail.tsx`) and are intentionally absent
 * here — they're peek-alongside drawers, not central tabs.
 */
import {
  Archive,
  BookOpen,
  BookText,
  FlaskConical,
  FolderOpen,
  FolderTree,
  GitBranch,
  GitCompare,
  KanbanSquare,
  MessageCircle,
  MessageSquare,
  Network,
  TerminalSquare,
  type LucideIcon,
} from 'lucide-react';
import type { BuildTab, DataTab, WorkTab, Zone } from './types.js';

export interface TabDef {
  zone: Zone;
  tab: WorkTab | BuildTab | DataTab;
  Icon: LucideIcon;
  /** i18n key. When missing in dictionary, `fallbackLabel` is shown. */
  labelKey: string;
  fallbackLabel: string;
}

export const TAB_REGISTRY: readonly TabDef[] = [
  // Work — day-to-day collaboration
  { zone: 'work', tab: 'board', Icon: MessageSquare, labelKey: 'company.board', fallbackLabel: 'Board' },
  { zone: 'work', tab: 'kanban', Icon: KanbanSquare, labelKey: 'company.kanban', fallbackLabel: 'Kanban' },
  { zone: 'work', tab: 'pipelines', Icon: Network, labelKey: 'company.pipelines', fallbackLabel: 'Pipelines' },
  { zone: 'work', tab: 'transcript', Icon: MessageCircle, labelKey: 'company.transcript', fallbackLabel: 'Transcript' },
  // Build — agent artefacts
  { zone: 'build', tab: 'docs', Icon: BookText, labelKey: 'company.docs', fallbackLabel: 'Docs' },
  { zone: 'build', tab: 'tests', Icon: FlaskConical, labelKey: 'company.tests', fallbackLabel: 'Tests' },
  { zone: 'build', tab: 'files', Icon: FolderTree, labelKey: 'company.files', fallbackLabel: 'Files' },
  { zone: 'build', tab: 'git', Icon: GitBranch, labelKey: 'company.git', fallbackLabel: 'Git' },
  { zone: 'build', tab: 'api', Icon: BookOpen, labelKey: 'company.apiReference', fallbackLabel: 'API' },
  { zone: 'build', tab: 'terminal', Icon: TerminalSquare, labelKey: 'company.terminal', fallbackLabel: 'Terminal' },
  // Data — persistence
  { zone: 'data', tab: 'drive', Icon: FolderOpen, labelKey: 'company.drive', fallbackLabel: 'Drive' },
  { zone: 'data', tab: 'snapshots', Icon: GitCompare, labelKey: 'company.snapshots', fallbackLabel: 'Snapshots' },
  { zone: 'data', tab: 'archived', Icon: Archive, labelKey: 'company.archived', fallbackLabel: 'Archived' },
] as const;
