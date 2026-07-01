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
 * `advanced: true` demotes a tab into the collapsed "More" group at the
 * bottom of the rail (chevron toggle, persisted in localStorage). Nothing
 * is removed: every tab keeps rendering and deep links auto-expand the
 * group. Demotion is reversible by flipping the flag.
 *
 * NOTE: Inbox / Env / Databases live on the RIGHT rail
 * (`preview-sidebar/SidebarRail.tsx`) and are intentionally absent
 * here — they're peek-alongside drawers, not central tabs.
 */
import {
  Archive,
  BookOpen,
  BookText,
  Brain,
  FlaskConical,
  FolderOpen,
  FolderTree,
  GitBranch,
  GitCompare,
  KanbanSquare,
  MessageSquare,
  Network,
  Play,
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
  /** Collapsed into the "More" group by default. */
  advanced?: boolean;
}

export const TAB_REGISTRY: readonly TabDef[] = [
  // ── Core — the day-to-day orchestration loop ─────────────────────
  { zone: 'work', tab: 'board', Icon: MessageSquare, labelKey: 'company.board', fallbackLabel: 'Board' },
  { zone: 'work', tab: 'kanban', Icon: KanbanSquare, labelKey: 'company.kanban', fallbackLabel: 'Kanban' },
  // Project memory (Mem C) — distilled decisions/gotchas from prior runs;
  // what subordinates are born knowing. Operator curates it here.
  { zone: 'work', tab: 'memory', Icon: Brain, labelKey: 'company.memory', fallbackLabel: 'Memory' },
  { zone: 'build', tab: 'files', Icon: FolderTree, labelKey: 'company.files', fallbackLabel: 'Files' },
  { zone: 'build', tab: 'git', Icon: GitBranch, labelKey: 'company.git', fallbackLabel: 'Git' },
  { zone: 'data', tab: 'drive', Icon: FolderOpen, labelKey: 'company.drive', fallbackLabel: 'Drive' },
  // Terminal moved out of the build zone — it's a global bottom panel
  // toggled from SessionHeader (Ctrl+J), always reachable.

  // ── Advanced ("More") — observation/introspection surfaces ──────
  { zone: 'work', tab: 'pipelines', Icon: Network, labelKey: 'company.pipelines', fallbackLabel: 'Pipelines', advanced: true },
  { zone: 'build', tab: 'docs', Icon: BookText, labelKey: 'company.docs', fallbackLabel: 'Docs', advanced: true },
  { zone: 'build', tab: 'tests', Icon: FlaskConical, labelKey: 'company.tests', fallbackLabel: 'Tests', advanced: true },
  { zone: 'build', tab: 'api', Icon: BookOpen, labelKey: 'company.apiReference', fallbackLabel: 'API', advanced: true },
  { zone: 'build', tab: 'runners', Icon: Play, labelKey: 'company.runners', fallbackLabel: 'Runners', advanced: true },
  { zone: 'data', tab: 'snapshots', Icon: GitCompare, labelKey: 'company.snapshots', fallbackLabel: 'Snapshots', advanced: true },
  { zone: 'data', tab: 'archived', Icon: Archive, labelKey: 'company.archived', fallbackLabel: 'Archived', advanced: true },
] as const;
