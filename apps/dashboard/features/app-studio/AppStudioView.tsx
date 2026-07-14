import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { Panel, PanelGroup, type ImperativePanelHandle } from 'react-resizable-panels';
import { ArrowLeft, ListChecks, Loader2, Rocket, Wrench } from 'lucide-react';
import { Button } from '../../components/ui/button.js';
import { confirm } from '../../components/ui/prompt-dialog.js';
import { StatusBarShell } from '../../components/chrome/index.js';
import { WorkbenchResizeHandle, WorkbenchShell, WorkbenchSurface } from '../../components/workbench/index.js';
import type { AppStudioSessionDetail, AppWorkflowPhaseId } from './app-studio-api.js';
import { useAppStudioSession } from './useAppStudioSession.js';
import { AppStudioRail, AppStudioTabContent, type AppStudioTab } from './AppStudioRail.js';
import { AppPreviewPanel } from './preview/AppPreviewPanel.js';
import { AppStudioSurfaceFind } from './AppStudioSurfaceFind.js';
import { AppStudioRightPanel, AppStudioRightRail, type AppStudioSidePanel } from './AppStudioRightRail.js';

const TAB_STORAGE_KEY = 'mcp.app-studio.tab.v5';
const ADVANCED_SEEN_KEY = 'mcp.app-studio.advanced-seen';
const TAB_IDS: AppStudioTab[] = ['guide', 'product', 'blueprint', 'versions', 'architecture', 'experience', 'preview', 'data', 'publish'];
const PHASE_TAB: Record<AppWorkflowPhaseId, AppStudioTab> = { define: 'guide', blueprint: 'blueprint', build: 'preview', deliver: 'guide' };

function usePersistedTab(): [AppStudioTab, (tab: AppStudioTab) => void] {
  const [value, setValue] = useState<AppStudioTab>(() => {
    try {
      const raw = window.localStorage.getItem(TAB_STORAGE_KEY);
      return TAB_IDS.includes(raw as AppStudioTab) ? raw as AppStudioTab : 'guide';
    } catch { return 'guide'; }
  });
  const set = useCallback((tab: AppStudioTab) => {
    setValue(tab);
    try { window.localStorage.setItem(TAB_STORAGE_KEY, tab); } catch { /* ignore */ }
  }, []);
  return [value, set];
}

function statusChip(detail: AppStudioSessionDetail, t: (key: string, options?: object) => string) {
  if (detail.deploy?.url) return { label: t('home.status.live'), cls: 'bg-emerald-500/15 text-emerald-700' };
  const attention = detail.workflow.attention.approval_ids.length + detail.workflow.attention.decision_ids.length;
  if (attention > 0) return { label: t('home.status.review'), cls: 'bg-amber-500/15 text-amber-700' };
  const current = detail.workflow.state.phases.find((phase) => phase.status === 'active' || phase.status === 'attention');
  if (!current) return { label: t('home.status.done'), cls: 'bg-emerald-500/15 text-emerald-700' };
  const index = detail.workflow.state.phases.findIndex((phase) => phase.id === current.id);
  return { label: t('home.status.building', { n: index + 1, total: 4 }), cls: 'bg-primary/10 text-primary' };
}

export function AppStudioView({
  sessionId,
  initialCoderSessionId,
  initialIdeaPrompt,
  onBack,
}: {
  sessionId: number;
  initialCoderSessionId?: number;
  initialIdeaPrompt?: string | null;
  onBack: () => void;
}) {
  const { t } = useTranslation('appStudio');
  const navigate = useNavigate();
  const { detail, error, refresh } = useAppStudioSession(sessionId);
  const [activeTab, setActiveTab] = usePersistedTab();
  const [compact, setCompact] = useState(() => window.matchMedia('(max-width: 767px)').matches);
  const [sidePanel, setSidePanel] = useState<AppStudioSidePanel | null>(() => initialIdeaPrompt?.trim() ? 'chat' : window.matchMedia('(max-width: 767px)').matches ? null : 'agents');
  const sidePanelRef = useRef<ImperativePanelHandle>(null);
  const lastPhase = useRef<AppWorkflowPhaseId | null>(null);

  useEffect(() => {
    const media = window.matchMedia('(max-width: 767px)');
    const update = () => setCompact(media.matches);
    update();
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);

  useEffect(() => {
    if (compact) return;
    if (sidePanel === null) sidePanelRef.current?.collapse();
    else sidePanelRef.current?.expand();
  }, [sidePanel, compact]);

  const currentPhase = detail?.workflow.state.phases.find((phase) => phase.status === 'active' || phase.status === 'attention')?.id ?? null;
  useEffect(() => {
    if (!currentPhase || lastPhase.current === currentPhase) return;
    if (lastPhase.current !== null) setActiveTab(PHASE_TAB[currentPhase]);
    lastPhase.current = currentPhase;
  }, [currentPhase, setActiveTab]);

  async function openAdvanced() {
    if (!detail?.project) return;
    let seen = false;
    try { seen = window.localStorage.getItem(ADVANCED_SEEN_KEY) === '1'; } catch { /* ignore */ }
    if (!seen) {
      const proceed = await confirm({ title: t('advanced.confirmTitle'), description: t('advanced.confirmBody'), confirmLabel: t('advanced.confirm') });
      if (!proceed) return;
      try { window.localStorage.setItem(ADVANCED_SEEN_KEY, '1'); } catch { /* ignore */ }
    }
    navigate(`/projects/${detail.project.id}`);
  }

  if (error && !detail) return <div className="space-y-3 p-6 text-sm"><div className="rounded border border-red-500/30 bg-red-500/10 p-3 text-red-700">{error}</div><Button variant="outline" size="sm" onClick={onBack}><ArrowLeft className="mr-1 h-4 w-4" />{t('backToApps')}</Button></div>;
  if (!detail?.project) return <div className="flex items-center gap-2 p-6 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />{t('create.creating')}</div>;

  const { session, project, builder_port: builderPort, workflow } = detail;
  const chip = statusChip(detail, t as never);
  const attentionCount = workflow.attention.approval_ids.length + workflow.attention.decision_ids.length;
  const coordinatorSessionId = workflow.coordinator_session_id ?? session.coordinator_session_id ?? initialCoderSessionId ?? null;
  const agentRefreshKey = workflow.work_items.map((item) => `${item.id}:${item.status}:${item.updated_at}`).join('|');
  const toggleSidePanel = (panel: AppStudioSidePanel) => setSidePanel((current) => current === panel ? null : panel);
  const rightPanel = sidePanel ? <AppStudioRightPanel active={sidePanel} appSessionId={sessionId} projectId={project.id} projectName={project.name} coordinatorSessionId={coordinatorSessionId} initialPrompt={initialIdeaPrompt} refreshKey={agentRefreshKey} /> : null;

  return (
    <WorkbenchShell>
      <header className="flex h-9 shrink-0 items-center gap-2 border-b border-[var(--workbench-border)] bg-[var(--workbench-raised)] px-2">
        <Button variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={onBack}><ArrowLeft className="h-3.5 w-3.5 sm:mr-1" /><span className="hidden sm:inline">{t('backToApps')}</span></Button>
        <span aria-hidden className="h-4 w-px bg-[var(--workbench-border)]" />
        <div className="min-w-0 flex-1"><span className="truncate text-xs font-semibold">{session.name}</span><span className={`ml-2 rounded-full px-2 py-0.5 text-[11px] ${chip.cls}`}>{chip.label}</span></div>
        {error && <span className="truncate text-xs text-red-600">{error}</span>}
        {attentionCount > 0 && <Button variant="outline" size="sm" className="h-7 gap-1 px-2 text-xs" onClick={() => setActiveTab('guide')}><ListChecks className="h-3.5 w-3.5" />{t('workflow.attention')}<span className="rounded-full bg-violet-600 px-1 text-[9px] text-white">{attentionCount}</span></Button>}
        {workflow.state.release_unlocked && <Button size="sm" className="h-7 gap-1 px-2 text-xs" onClick={() => setActiveTab('publish')}><Rocket className="h-3.5 w-3.5" />{t('tabs.publish')}</Button>}
        <Button variant="ghost" size="sm" className="h-7 px-2 text-xs text-muted-foreground" onClick={() => void openAdvanced()}><Wrench className="h-3.5 w-3.5 sm:mr-1" /><span className="hidden sm:inline">{t('advanced.label')}</span></Button>
      </header>

      <div className="flex min-h-0 min-w-0 flex-1">
        <AppStudioRail active={activeTab} detail={detail} onSelect={setActiveTab} />
        <div className="relative min-w-0 flex-1 p-1.5">
          <PanelGroup direction="horizontal" autoSaveId={`mcp-app-studio-workbench-v5-${sessionId}`} className="min-h-0 min-w-0">
            <Panel id="app-stage" order={1} defaultSize={compact ? 100 : 72} minSize={compact ? 100 : 48} className="min-w-0">
              <WorkbenchSurface className="flex h-full min-h-0 flex-col">
                <div className="min-h-0 flex-1 overflow-hidden">
                  <AppStudioSurfaceFind key={activeTab}>
                    {activeTab === 'preview' ? <AppPreviewPanel projectId={project.id} builderPort={builderPort} onHide={() => setActiveTab(detail.spec ? 'blueprint' : 'guide')} /> : <AppStudioTabContent tab={activeTab} detail={detail} onChanged={() => void refresh()} />}
                  </AppStudioSurfaceFind>
                </div>
              </WorkbenchSurface>
            </Panel>
            {!compact && <><WorkbenchResizeHandle direction="horizontal" disabled={sidePanel === null} className={sidePanel === null ? 'w-0 cursor-default' : undefined} /><Panel ref={sidePanelRef} id="app-agent-rail" order={2} defaultSize={sidePanel ? 30 : 0} minSize={22} maxSize={46} collapsible collapsedSize={0} onCollapse={() => setSidePanel(null)} className="min-w-0"><WorkbenchSurface className="h-full">{rightPanel}</WorkbenchSurface></Panel></>}
          </PanelGroup>
          {compact && sidePanel && <aside className="absolute inset-1.5 z-40 shadow-xl"><WorkbenchSurface className="h-full">{rightPanel}</WorkbenchSurface></aside>}
        </div>
        <AppStudioRightRail active={sidePanel} onToggle={toggleSidePanel} />
      </div>
      <StatusBarShell>
        <span className={`h-1.5 w-1.5 rounded-full ${detail.deploy?.url ? 'bg-emerald-500' : attentionCount ? 'bg-amber-400' : 'bg-violet-400'}`} />
        <span className="max-w-[180px] truncate">{session.name}</span><span className="opacity-40">·</span><span>{chip.label}</span>
        <span className="ml-auto truncate">{currentPhase ? t(`workflow.phases.${currentPhase}`) : t('home.status.done')}</span>
      </StatusBarShell>
    </WorkbenchShell>
  );
}
