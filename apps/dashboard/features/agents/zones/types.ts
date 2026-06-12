/**
 * Three-zone IA for the company-mode view. Each zone groups related
 * inner tabs that REPLACE the central content area when selected:
 *
 *   - Work:  team day-to-day work (Board, Kanban, Pipelines)
 *   - Build: artefacts the team produces (Docs, Tests, Files, Git, API)
 *   - Data:  per-session persistence surfaces (Drive, Snapshots, Archived)
 *
 * Companion right-side drawer lives in `preview-sidebar/SidebarRail`
 * and hosts Preview / Inbox / Env / Databases — the "peek" panels that
 * the user often wants alongside whatever central tab is active rather
 * than instead of it.
 */
export type Zone = 'work' | 'build' | 'data';

export type WorkTab = 'board' | 'kanban' | 'memory' | 'pipelines' | 'transcript';
export type BuildTab = 'docs' | 'tests' | 'files' | 'git' | 'api' | 'terminal' | 'runners';
// `indexed` = project's indexed-file table (path · lang · lines · layer ·
// complexity + summarization). `vectors` = hybrid/vector/FTS search of
// the embedded corpus. Both read across the session's linked projects
// via a ProjectSelect inside the tab.
export type DataTab = 'drive' | 'snapshots' | 'archived' | 'indexed' | 'vectors';

export type ZoneTab =
  | { zone: 'work'; tab: WorkTab }
  | { zone: 'build'; tab: BuildTab }
  | { zone: 'data'; tab: DataTab };

export const ZONE_TABS: { [Z in Zone]: readonly Extract<ZoneTab, { zone: Z }>['tab'][] } = {
  work: ['board', 'kanban', 'memory', 'pipelines', 'transcript'] as const,
  build: ['docs', 'tests', 'files', 'git', 'api', 'terminal', 'runners'] as const,
  data: ['drive', 'snapshots', 'archived', 'indexed', 'vectors'] as const,
};

export const DEFAULT_TAB_FOR_ZONE: { [Z in Zone]: Extract<ZoneTab, { zone: Z }>['tab'] } = {
  work: 'board',
  build: 'docs',
  data: 'drive',
};

export const ZONES: readonly Zone[] = ['work', 'build', 'data'] as const;

export function isValidTab<Z extends Zone>(zone: Z, tab: string): tab is Extract<ZoneTab, { zone: Z }>['tab'] {
  return (ZONE_TABS[zone] as readonly string[]).includes(tab);
}

export function findZoneForTab(tab: string): Zone | null {
  for (const z of ZONES) {
    if ((ZONE_TABS[z] as readonly string[]).includes(tab)) return z;
  }
  return null;
}
