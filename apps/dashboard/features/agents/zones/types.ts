/**
 * Three-zone IA for the company-mode view. Each zone groups related
 * inner tabs so the 12 flat tabs that used to live in
 * `CompanySessionView` are organized hierarchically:
 *
 *   - Work: where the team operates (board, kanban, inbox, pipelines)
 *   - Build: the artefacts the team produces (docs, api ref, tests; +preview/git in later phases)
 *   - Data: persistence and observability (drive, env, databases, snapshots, archived)
 *
 * Phase 1 keeps zone + tab in component state. Phase 1b will move them
 * to the URL (`/company/sessions/:rootId/:frontId/:zone/:tab`).
 */
export type Zone = 'work' | 'build' | 'data';

export type WorkTab = 'board' | 'kanban' | 'inbox' | 'pipelines';
export type BuildTab = 'docs' | 'api' | 'tests' | 'git';
export type DataTab = 'drive' | 'env' | 'databases' | 'snapshots' | 'archived';

export type ZoneTab =
  | { zone: 'work'; tab: WorkTab }
  | { zone: 'build'; tab: BuildTab }
  | { zone: 'data'; tab: DataTab };

export const ZONE_TABS: { [Z in Zone]: readonly Extract<ZoneTab, { zone: Z }>['tab'][] } = {
  work: ['board', 'kanban', 'inbox', 'pipelines'] as const,
  build: ['docs', 'api', 'tests', 'git'] as const,
  data: ['drive', 'env', 'databases', 'snapshots', 'archived'] as const,
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
