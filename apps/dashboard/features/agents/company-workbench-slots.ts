export type CompanyCatalogView = 'sessions' | 'templates';

export interface CompanyCatalogRail {
  open: boolean;
  activeView: CompanyCatalogView;
  sessionCount?: number;
  templateCount?: number;
  onToggle: (view: CompanyCatalogView) => void;
}

/**
 * Hosts and global actions supplied by AgentsTab to an opened Company session.
 * The session keeps ownership of its zone state while its rail is rendered at
 * the outer workbench edge, avoiding two adjacent activity rails.
 */
export interface CompanySessionWorkbenchSlots {
  leftRailHost: HTMLElement | null;
  catalog: CompanyCatalogRail;
}
