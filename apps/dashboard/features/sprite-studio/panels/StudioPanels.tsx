/**
 * StudioPanels — the IDE-style collapsible 3-rail layout of the studio:
 * left (tabs: Library | Files), center, right (Inspector), plus the bottom
 * shell. Collapse state + active left tab persist per project (ui-state).
 * The parent supplies the CONTENT nodes; this component owns only chrome,
 * tabs, rails and the resizable geometry.
 */
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Panel, PanelGroup, PanelResizeHandle } from 'react-resizable-panels';
import { LayoutGrid, SlidersHorizontal } from 'lucide-react';
import { loadSpriteStudioUi, saveSpriteStudioUi } from '../sprite-studio-ui-state.js';
import type { StudioMode } from '../types.js';
import { CollapsedRail, PanelChrome } from './PanelChrome.js';
import { LeftTabs } from './LeftTabs.js';
import { BottomPanel } from './BottomPanel.js';
import { panelsForSide } from './panel-registry.js';

type Collapsed = { left: boolean; right: boolean; bottom: boolean };

export function StudioPanels({
  projectId,
  mode,
  library,
  frames,
  center,
  inspector,
}: {
  projectId: number;
  /** Current studio mode — entering `animate` auto-focuses the Frames tab. */
  mode: StudioMode;
  /** The Library panel content (mounted directly — see panel-registry note). */
  library: React.ReactNode;
  /** The Frames-browser content (mounted directly, like library). */
  frames: React.ReactNode;
  center: React.ReactNode;
  inspector: React.ReactNode;
}) {
  const { t } = useTranslation('spriteStudio');
  const leftDefs = panelsForSide('left');

  const [collapsed, setCollapsed] = useState<Collapsed>(() => {
    const ui = loadSpriteStudioUi(projectId);
    return ui?.panelsCollapsed ?? { left: false, right: false, bottom: true };
  });
  const [leftTab, setLeftTab] = useState<string>(
    () => loadSpriteStudioUi(projectId)?.leftTab ?? 'library',
  );

  const toggle = (side: keyof Collapsed) => {
    setCollapsed((prev) => {
      const next = { ...prev, [side]: !prev[side] };
      saveSpriteStudioUi(projectId, { panelsCollapsed: next });
      return next;
    });
  };

  const pickLeftTab = (id: string) => {
    setLeftTab(id);
    saveSpriteStudioUi(projectId, { leftTab: id });
  };

  // Entering animate mode focuses Frames once — unless the user is on Files.
  const prevMode = useRef(mode);
  useEffect(() => {
    if (mode === 'animate' && prevMode.current !== 'animate' && leftTab === 'library') {
      pickLeftTab('frames');
    }
    prevMode.current = mode;
  }, [mode, leftTab]); // eslint-disable-line react-hooks/exhaustive-deps

  const activeDef = leftDefs.find((d) => d.id === leftTab) ?? leftDefs[0];
  const leftContent = activeDef?.id === 'library'
    ? library
    : activeDef?.id === 'frames'
      ? frames
      : activeDef?.render({ projectId }) ?? library;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="min-h-0 flex-1">
        {/* Key re-inits the resizable layout when rails collapse/expand. */}
        <PanelGroup
          key={`h-${collapsed.left}-${collapsed.right}`}
          direction="horizontal"
          autoSaveId={`mcp-sprite-studio-h-${projectId}-${collapsed.left}-${collapsed.right}`}
        >
          {collapsed.left ? null : (
            <>
              <Panel defaultSize={20} minSize={14} maxSize={36}>
                <div className="flex h-full min-h-0 overflow-hidden">
                  <LeftTabs active={activeDef?.id ?? 'library'} onChange={pickLeftTab} tabs={leftDefs} />
                  <PanelChrome
                    title={t(activeDef?.titleKey ?? 'library.title')}
                    icon={activeDef?.icon ?? LayoutGrid}
                    side="left"
                    collapsed={false}
                    onToggle={() => toggle('left')}
                    className="min-w-0 flex-1"
                  >
                    {leftContent}
                  </PanelChrome>
                </div>
              </Panel>
              <PanelResizeHandle className="w-px bg-border transition-colors hover:bg-primary/40" />
            </>
          )}
          <Panel minSize={30}>
            <div className="flex h-full min-h-0">
              {collapsed.left && (
                <CollapsedRail
                  title={t('panels.expand')}
                  icon={LayoutGrid}
                  side="left"
                  onToggle={() => toggle('left')}
                />
              )}
              <div className="min-w-0 flex-1">{center}</div>
              {collapsed.right && (
                <CollapsedRail
                  title={t('panels.expand')}
                  icon={SlidersHorizontal}
                  side="right"
                  onToggle={() => toggle('right')}
                />
              )}
            </div>
          </Panel>
          {collapsed.right ? null : (
            <>
              <PanelResizeHandle className="w-px bg-border transition-colors hover:bg-primary/40" />
              <Panel defaultSize={26} minSize={18} maxSize={40}>
                <PanelChrome
                  title={t('panels.inspector')}
                  icon={SlidersHorizontal}
                  side="right"
                  collapsed={false}
                  onToggle={() => toggle('right')}
                >
                  {inspector}
                </PanelChrome>
              </Panel>
            </>
          )}
        </PanelGroup>
      </div>
      <BottomPanel collapsed={collapsed.bottom} onToggle={() => toggle('bottom')} />
    </div>
  );
}
