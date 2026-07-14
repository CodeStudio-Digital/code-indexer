/**
 * Navigate to a pin + compute which pin (if any) matches the current view.
 *
 * Activation is URL-first: `navigate(pin.href)` reproduces project / session /
 * rail (ProjectView applies `?tab=` on mount). Only a rail pin's optional
 * `restore` (a workspace-layout drawer that isn't in the URL) needs a
 * post-navigation nudge, scheduled with `queueMicrotask` so it lands after the
 * synchronous navigate. Active-match is recomputed from live location every
 * render — no stored "active" flag, so no races.
 */
import type { NavigateFunction } from 'react-router-dom';
import type { Pin } from './pinned-tabs-types.js';
import type { ActiveProjectTab } from './active-surface.js';
import type { ActiveView } from '../lib/route-view.js';
import { useWorkspaceLayout } from './workspace-layout.js';

export function activatePin(pin: Pin, navigate: NavigateFunction): void {
  navigate(pin.href);
  if (pin.kind === 'rail' && pin.restore) {
    const { side, toolId } = pin.restore;
    queueMicrotask(() => {
      const l = useWorkspaceLayout.getState();
      if (side === 'right') l.setActiveRight(toolId);
      else if (side === 'left') l.setActiveLeft(toolId);
      else l.setActiveBottom(toolId);
    });
  }
}

export interface LiveView {
  view: ActiveView;
  pathname: string;
  search: string;
  activeProjectTab: ActiveProjectTab | null;
}

function railTabOf(live: LiveView): string {
  const { view, activeProjectTab, search } = live;
  if (view.projectId != null && activeProjectTab && activeProjectTab.projectId === view.projectId) {
    return activeProjectTab.tab;
  }
  return new URLSearchParams(search).get('tab') || 'editor';
}

function isPinActive(pin: Pin, live: LiveView): boolean {
  const { view, pathname } = live;
  switch (pin.kind) {
    case 'project':
      return (
        view.page === 'project' &&
        view.projectId === pin.projectId &&
        view.sessionId == null &&
        (railTabOf(live) === 'editor' || railTabOf(live) === 'chat')
      );
    case 'rail':
      return view.page === 'project' && view.projectId === pin.projectId && railTabOf(live) === pin.tabId;
    case 'session':
      if (pin.scope === 'project') {
        return view.page === 'project' && view.projectId === pin.projectId && view.sessionId === pin.sessionId;
      }
      if (pin.scope === 'global') {
        return view.page === 'global' && view.sessionId === pin.sessionId;
      }
      return pathname.startsWith(`/company/sessions/${pin.sessionId}/`);
  }
}

export function computeActiveId(pins: Pin[], live: LiveView): string | null {
  for (const pin of pins) {
    if (isPinActive(pin, live)) return pin.id;
  }
  return null;
}
