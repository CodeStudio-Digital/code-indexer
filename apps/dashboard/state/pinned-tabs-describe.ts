/**
 * Pin builders + `describeCurrentPin` — the pure bridge from "where the user
 * is" to a `Pin`. The header "pin this view" button calls `describeCurrentPin`;
 * the context menus call the `build*Pin` helpers directly. Everything here is
 * pure so it's trivially testable.
 */
import type { Pin, ProjectPin, RailPin, SessionPin, SessionScope } from './pinned-tabs-types.js';
import { projectPinId, railPinId, sessionPinId } from './pinned-tabs-types.js';
import type { ActiveProjectTab } from './active-surface.js';
import type { ActiveView } from '../lib/route-view.js';
import { railIconName } from '../components/pinned-tabs/icons.js';
import { TABS } from '../features/project/tabs-config.js';

const tabLabel = (id: string): string => TABS.find((t) => t.id === id)?.label ?? id;
const isKnownTab = (id: string): boolean => TABS.some((t) => t.id === id);

export function buildProjectPin(a: { projectId: number; name?: string | null }): ProjectPin {
  return {
    kind: 'project',
    projectId: a.projectId,
    id: projectPinId(a.projectId),
    label: a.name || `Project ${a.projectId}`,
    icon: 'FolderGit2',
    href: `/projects/${a.projectId}`,
  };
}

export function buildRailPin(a: {
  projectId: number;
  tabId: string;
  label?: string;
  projectName?: string | null;
}): RailPin {
  const base = a.label || tabLabel(a.tabId);
  return {
    kind: 'rail',
    projectId: a.projectId,
    tabId: a.tabId,
    id: railPinId(a.projectId, a.tabId),
    label: a.projectName ? `${a.projectName}: ${base}` : base,
    icon: railIconName(a.tabId),
    href: `/projects/${a.projectId}?tab=${a.tabId}`,
  };
}

export function buildSessionPin(a: {
  scope: SessionScope;
  sessionId: number;
  projectId?: number;
  title?: string | null;
  /** For company scope, the full canonical pathname (preserves zone/tab). */
  href?: string;
}): SessionPin {
  const href =
    a.href ??
    (a.scope === 'global'
      ? `/global?session=${a.sessionId}`
      : a.scope === 'project'
        ? `/projects/${a.projectId}?session=${a.sessionId}`
        : `/company/sessions/${a.sessionId}`);
  return {
    kind: 'session',
    scope: a.scope,
    sessionId: a.sessionId,
    projectId: a.projectId,
    id: sessionPinId(a.scope, a.sessionId),
    label: a.title || `Session ${a.sessionId}`,
    icon: a.scope === 'company' ? 'Users' : 'MessageSquareCode',
    href,
  };
}

/** Live rail tab for `projectId`: active-surface wins, else the URL `?tab=`. */
function railTabFor(
  projectId: number,
  activeProjectTab: ActiveProjectTab | null,
  search: string,
): string | null {
  if (activeProjectTab && activeProjectTab.projectId === projectId) return activeProjectTab.tab;
  return new URLSearchParams(search).get('tab') || null;
}

export interface DescribeInput {
  view: ActiveView;
  pathname: string;
  search: string;
  activeProjectTab: ActiveProjectTab | null;
  names: { projectName?: string | null; sessionTitle?: string | null };
}

/** The `Pin` for the current view, or null on pages with no pinnable target. */
export function describeCurrentPin(input: DescribeInput): Pin | null {
  const { view, pathname, search, activeProjectTab, names } = input;

  // Company session — the whole state (front/zone/tab) is in the URL.
  if (view.page === 'agents' && pathname.startsWith('/company/sessions/')) {
    const rootId = Number(pathname.split('/')[3]);
    if (!Number.isFinite(rootId)) return null;
    return buildSessionPin({
      scope: 'company',
      sessionId: rootId,
      title: names.sessionTitle,
      href: pathname,
    });
  }

  if (view.page === 'global' && view.sessionId != null) {
    return buildSessionPin({ scope: 'global', sessionId: view.sessionId, title: names.sessionTitle });
  }

  if (view.page === 'project' && view.projectId != null) {
    if (view.sessionId != null) {
      return buildSessionPin({
        scope: 'project',
        sessionId: view.sessionId,
        projectId: view.projectId,
        title: names.sessionTitle,
      });
    }
    const tab = railTabFor(view.projectId, activeProjectTab, search);
    if (tab && tab !== 'chat' && isKnownTab(tab)) {
      return buildRailPin({ projectId: view.projectId, tabId: tab, projectName: names.projectName });
    }
    return buildProjectPin({ projectId: view.projectId, name: names.projectName });
  }

  return null;
}
