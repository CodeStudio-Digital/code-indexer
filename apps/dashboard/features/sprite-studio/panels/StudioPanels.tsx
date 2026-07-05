/**
 * StudioPanels — the studio's IDE shell, aligned with ProjectView's chrome:
 *
 *   ┌────┬──────────────────────────────┬────┐
 *   │ L  │  left body │ center │ right   │ R  │   ← icon rails (RailContainer)
 *   │rail│  (tab)     │ canvas │ inspect │rail│     flank a horizontal group
 *   ├────┴──────────────────────────────┴────┤
 *   │ bottom dock (resizable Panel)          │   ← vertical group, bounded
 *   └─────────────────────────────────────────┘
 *
 * The left rail switches which panel occupies the left body (IntelliJ-style:
 * clicking the active tab collapses it) and toggles the bottom console; the
 * right rail toggles the inspector. The bottom dock is a real resizable Panel
 * (minSize/maxSize) inside a vertical PanelGroup — so it can NEVER take over the
 * window (the old bug). Collapse state + active left tab persist per project.
 *
 * The parent supplies the CONTENT nodes; this component owns only chrome, rails
 * and the resizable geometry — using the shared RailButton/RailContainer so it
 * reads as the same system as ProjectView.
 */
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Panel, PanelGroup, PanelResizeHandle } from 'react-resizable-panels';
import { LayoutGrid, SlidersHorizontal, SquareTerminal } from 'lucide-react';
import { RailButton } from '../../../components/chrome/RailButton.js';
import { RailContainer } from '../../../components/chrome/RailContainer.js';
import { RailSeparator } from '../../../components/chrome/RailSeparator.js';
import { loadSpriteStudioUi, saveSpriteStudioUi } from '../sprite-studio-ui-state.js';
import type { StudioMode } from '../types.js';
import { PanelChrome } from './PanelChrome.js';
import { BottomPanel } from './BottomPanel.js';
import { panelsForSide } from './panel-registry.js';

type Collapsed = { left: boolean; right: boolean; bottom: boolean };

const HANDLE_V = 'w-px bg-border transition-colors hover:bg-primary/40';
const HANDLE_H = 'h-px bg-border transition-colors hover:bg-primary/40';

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

  const setSide = (side: keyof Collapsed, value: boolean) =>
    setCollapsed((prev) => {
      if (prev[side] === value) return prev;
      const next = { ...prev, [side]: value };
      saveSpriteStudioUi(projectId, { panelsCollapsed: next });
      return next;
    });
  const toggle = (side: keyof Collapsed) => setSide(side, !collapsed[side]);

  const pickLeftTab = (id: string) => {
    setLeftTab(id);
    saveSpriteStudioUi(projectId, { leftTab: id });
  };

  const activeDef = leftDefs.find((d) => d.id === leftTab) ?? leftDefs[0];

  useEffect(() => {
    const ui = loadSpriteStudioUi(projectId);
    setCollapsed(ui?.panelsCollapsed ?? { left: false, right: false, bottom: true });
    setLeftTab(ui?.leftTab ?? 'library');
  }, [projectId]);

  useEffect(() => {
    if (!activeDef || activeDef.id === leftTab) return;
    setLeftTab(activeDef.id);
    saveSpriteStudioUi(projectId, { leftTab: activeDef.id });
  }, [activeDef, leftTab, projectId]);

  // Left rail click: reopen+switch, or collapse when re-clicking the open tab.
  const onLeftTab = (id: string) => {
    if (!collapsed.left && activeDef?.id === id) {
      setSide('left', true);
    } else {
      setSide('left', false);
      pickLeftTab(id);
    }
  };

  // Entering animate mode focuses Frames once — unless the user is on Files.
  const prevMode = useRef(mode);
  useEffect(() => {
    if (mode === 'animate' && prevMode.current !== 'animate' && leftTab === 'library') {
      pickLeftTab('frames');
    }
    prevMode.current = mode;
  }, [mode, leftTab]); // eslint-disable-line react-hooks/exhaustive-deps

  const leftContent = activeDef?.id === 'library'
    ? library
    : activeDef?.id === 'frames'
      ? frames
      : activeDef?.render({ projectId }) ?? library;

  return (
    <div className="min-h-0 flex-1">
      <PanelGroup direction="vertical" autoSaveId={`mcp-sprite-studio-v-${projectId}`}>
        <Panel minSize={30}>
          <div className="flex h-full min-h-0">
            {/* LEFT icon rail — tab switch + console toggle in the footer. */}
            <RailContainer side="left" aria-label={t('panels.leftRail')}>
              {leftDefs.map((def) => (
                <RailButton
                  key={def.id}
                  icon={def.icon}
                  label={t(def.titleKey)}
                  active={!collapsed.left && activeDef?.id === def.id}
                  role="tab"
                  side="left"
                  onClick={() => onLeftTab(def.id)}
                />
              ))}
              <div className="mt-auto flex flex-col items-center gap-0.5">
                <RailSeparator />
                <RailButton
                  icon={SquareTerminal}
                  label={t('panels.console')}
                  active={!collapsed.bottom}
                  role="toggle"
                  side="left"
                  onClick={() => toggle('bottom')}
                />
              </div>
            </RailContainer>

            {/* Horizontal group: left body | center | right inspector. */}
            <div className="min-w-0 flex-1">
              <PanelGroup
                key={`h-${collapsed.left}-${collapsed.right}`}
                direction="horizontal"
                autoSaveId={`mcp-sprite-studio-h-${projectId}-${collapsed.left}-${collapsed.right}`}
              >
                {!collapsed.left && (
                  <>
                    <Panel defaultSize={20} minSize={14} maxSize={36}>
                      <PanelChrome
                        title={t(activeDef?.titleKey ?? 'library.title')}
                        icon={activeDef?.icon ?? LayoutGrid}
                        side="left"
                        collapsed={false}
                        onToggle={() => setSide('left', true)}
                      >
                        {leftContent}
                      </PanelChrome>
                    </Panel>
                    <PanelResizeHandle className={HANDLE_V} />
                  </>
                )}
                <Panel minSize={30}>
                  <div className="h-full min-h-0 min-w-0">{center}</div>
                </Panel>
                {!collapsed.right && (
                  <>
                    <PanelResizeHandle className={HANDLE_V} />
                    <Panel defaultSize={26} minSize={18} maxSize={40}>
                      <PanelChrome
                        title={t('panels.inspector')}
                        icon={SlidersHorizontal}
                        side="right"
                        collapsed={false}
                        onToggle={() => setSide('right', true)}
                      >
                        {inspector}
                      </PanelChrome>
                    </Panel>
                  </>
                )}
              </PanelGroup>
            </div>

            {/* RIGHT icon rail — single inspector toggle. */}
            <RailContainer side="right" aria-label={t('panels.rightRail')}>
              <RailButton
                icon={SlidersHorizontal}
                label={t('panels.inspector')}
                active={!collapsed.right}
                role="toggle"
                side="right"
                onClick={() => toggle('right')}
              />
            </RailContainer>
          </div>
        </Panel>
        {!collapsed.bottom && (
          <>
            <PanelResizeHandle className={HANDLE_H} />
            <Panel defaultSize={25} minSize={10} maxSize={60}>
              <BottomPanel onClose={() => setSide('bottom', true)} />
            </Panel>
          </>
        )}
      </PanelGroup>
    </div>
  );
}
