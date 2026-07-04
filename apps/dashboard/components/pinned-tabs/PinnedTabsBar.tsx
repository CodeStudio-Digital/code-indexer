/**
 * Global Pinned Tabs Bar — sits between the app header and `<main>` in
 * AppShell. Renders the persisted pins as tab chips; hidden when empty. Active
 * state is recomputed from live location + active-surface every render.
 */
import { useMemo } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { usePinnedTabs } from '../../state/pinned-tabs.js';
import { useActiveSurface } from '../../state/active-surface.js';
import { activatePin, computeActiveId } from '../../state/pinned-tabs-activate.js';
import { parseView } from '../../lib/route-view.js';
import { PinnedTab } from './PinnedTab.js';

export function PinnedTabsBar() {
  const pins = usePinnedTabs((s) => s.pins);
  const unpin = usePinnedTabs((s) => s.unpin);
  const reorder = usePinnedTabs((s) => s.reorder);
  const projectTab = useActiveSurface((s) => s.projectTab);
  const navigate = useNavigate();
  const location = useLocation();
  const { t } = useTranslation(['pins']);

  const view = useMemo(
    () => parseView(location.pathname, location.search),
    [location.pathname, location.search],
  );

  const activeId = useMemo(
    () =>
      computeActiveId(pins, {
        view,
        pathname: location.pathname,
        search: location.search,
        activeProjectTab: projectTab,
      }),
    [pins, view, location.pathname, location.search, projectTab],
  );

  if (pins.length === 0) return null;

  const handleReorder = (fromId: string, targetId: string, edge: 'left' | 'right'): void => {
    const ids = pins.map((p) => p.id);
    const ti = ids.indexOf(targetId);
    const beforeId = edge === 'left' ? targetId : (ids[ti + 1] ?? null);
    reorder(fromId, beforeId);
  };

  return (
    <div
      role="tablist"
      aria-label={t('pins:barAria')}
      className="flex h-8 shrink-0 items-center gap-1 overflow-x-auto border-b bg-card/40 px-2 flex-nowrap"
    >
      {pins.map((pin) => (
        <PinnedTab
          key={pin.id}
          pin={pin}
          active={pin.id === activeId}
          onActivate={() => activatePin(pin, navigate)}
          onUnpin={() => unpin(pin.id)}
          onReorder={handleReorder}
          closeLabel={t('pins:closeAria', { label: pin.label })}
        />
      ))}
    </div>
  );
}
