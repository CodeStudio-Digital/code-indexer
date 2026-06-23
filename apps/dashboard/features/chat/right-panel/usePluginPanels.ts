/**
 * Plugin tool windows for the chat session's right rail. Hydrates the
 * contribution registry for the session's project (activation rules apply —
 * a window with no rule, like Cloudflare's, always surfaces) and returns the
 * `side: 'right'` windows.
 *
 * Also guards the persisted active-panel id: `chatRightPanelId` may point at
 * a plugin that has since been uninstalled/disabled. We only reset AFTER the
 * registry hydrates — resetting earlier would close the panel on every boot
 * (registry starts empty) and flicker.
 */
import { useEffect, useMemo } from 'react';
import {
  hydrateContributions,
  useContributions,
  type ContribToolWindow,
} from '../../../state/contribution-registry.js';
import type { RightPanelId } from './types.js';

export function usePluginPanels(
  projectId: number,
  activeId: RightPanelId | null,
  setActiveId: (id: RightPanelId | null) => void,
): ContribToolWindow[] {
  const toolWindows = useContributions((s) => s.toolWindows);
  const hydrated = useContributions((s) => s.hydrated);

  useEffect(() => {
    void hydrateContributions(projectId);
  }, [projectId]);

  const rightWindows = useMemo(
    () => toolWindows.filter((w) => w.side === 'right'),
    [toolWindows],
  );

  useEffect(() => {
    if (!hydrated || !activeId?.startsWith('plugin:')) return;
    const alive = rightWindows.some((w) => `plugin:${w.pluginNs}:${w.id}` === activeId);
    if (!alive) setActiveId(null);
  }, [hydrated, activeId, rightWindows, setActiveId]);

  return rightWindows;
}
