/**
 * Tab identity for the Session Insights rail, split out of the panel itself.
 *
 * `AgentChat` needs the storage key + event name to deep-link a tab (e.g. the
 * header's "usage" shortcut), but importing them from `SessionInsightsPanel`
 * dragged that panel — and with it the session metrics, tool stats and session
 * details views, ~1.9k lines — into the chat's eager chunk, defeating the
 * lazy() boundary in `RightPanelHost`. Constants live here so both sides can
 * share them without pulling any component code.
 */
export type SessionInsightsTab = 'overview' | 'usage' | 'tools' | 'inputs';

export const SESSION_INSIGHTS_TAB_STORAGE_KEY = 'chatSessionInsightsTab';
export const SESSION_INSIGHTS_TAB_EVENT = 'coder:session-insights-tab';

export const SESSION_INSIGHTS_TABS = new Set<SessionInsightsTab>([
  'overview',
  'usage',
  'tools',
  'inputs',
]);

export function readInitialSessionInsightsTab(): SessionInsightsTab {
  if (typeof window === 'undefined') return 'overview';
  const saved = window.localStorage.getItem(
    SESSION_INSIGHTS_TAB_STORAGE_KEY,
  ) as SessionInsightsTab | null;
  return saved && SESSION_INSIGHTS_TABS.has(saved) ? saved : 'overview';
}
