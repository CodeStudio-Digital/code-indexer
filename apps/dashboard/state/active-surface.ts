/**
 * Active surface — live, non-persisted signal of which project rail tab is
 * currently showing. ProjectView holds its active tab in local `useState` and
 * `setRouteTab` is telemetry-only, so the tab never reaches the URL. The Pinned
 * Tabs Bar (and the header "pin this view" button) need it to (a) capture a
 * rail pin for the view you're actually on and (b) highlight the active rail
 * chip. ProjectView publishes here on every tab change; company sessions don't
 * need this (their zone/tab live in the URL).
 */
import { create } from 'zustand';

export interface ActiveProjectTab {
  projectId: number;
  tab: string;
  workspaceId?: number | null;
  worktreePath?: string | null;
}

interface ActiveSession {
  id: string;
  title: string;
}

interface ActiveSurfaceState {
  /** Metadata already loaded by the visible chat; never fetch history for the shell. */
  session: ActiveSession | null;
  setSession: (session: ActiveSession | null) => void;
  projectTab: ActiveProjectTab | null;
  setProjectTab: (v: ActiveProjectTab | null) => void;
}

export const useActiveSurface = create<ActiveSurfaceState>((set) => ({
  session: null,
  setSession: (session) => set({ session }),
  projectTab: null,
  setProjectTab: (v) => set({ projectTab: v }),
}));

export function acceptsWorkspaceTab(projectId: number): boolean {
  const workspaceId = useActiveSurface.getState().projectTab?.workspaceId;
  return workspaceId === undefined || workspaceId === projectId;
}
