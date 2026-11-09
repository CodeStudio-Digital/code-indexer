import type { ReactNode } from 'react';

export type CompanyCatalogView = 'sessions' | 'templates';

export interface CompanyCatalogRail {
  open: boolean;
  activeView: CompanyCatalogView;
  sessionCount?: number;
  templateCount?: number;
  onToggle: (view: CompanyCatalogView) => void;
  onOpenChange: (open: boolean) => void;
}

export interface CompanySessionsRail {
  open: boolean;
  onToggle: () => void;
}

/**
 * Hosts and global actions supplied by AgentsTab to an opened Company session.
 * The session keeps ownership of its zone state while its rail is rendered at
 * the outer workbench edge, avoiding two adjacent activity rails.
 */
export interface CompanySessionWorkbenchSlots {
  leftRailHost: HTMLElement | null;
  catalog: CompanyCatalogRail;
  /** Catalog surface rendered as the session workbench's left dock. */
  catalogPanel: ReactNode;
}
