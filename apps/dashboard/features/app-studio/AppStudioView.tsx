import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Panel, PanelGroup, type ImperativePanelHandle } from 'react-resizable-panels';
import { ArrowLeft, Loader2, MessageSquare, Pause, Play, Square } from 'lucide-react';
import { Button } from '../../components/ui/button.js';
import { confirm } from '../../components/ui/prompt-dialog.js';
import { StatusBarShell } from '../../components/chrome/index.js';
import { WorkbenchResizeHandle, WorkbenchShell, WorkbenchSurface } from '../../components/workbench/index.js';
import { useAppStudioSession } from './useAppStudioSession.js';
import { runAppAction, type AppStage } from './app-studio-api.js';
import { AppStudioRail, AppStudioTabContent, type AppStudioTab } from './AppStudioRail.js';
import { AppPreviewPanel } from './preview/AppPreviewPanel.js';
import { AppStudioSurfaceFind } from './AppStudioSurfaceFind.js';
import { AppStudioRightPanel, AppStudioRightRail } from './AppStudioRightRail.js';

const TAB_KEY = 'mcp.app-studio.tab.v6';
const TAB_IDS: AppStudioTab[] = ['plan', 'app', 'data', 'publish'];
const STAGE_KEYS: Record<AppStage, string> = { planning: 'v6.stages.planning', building: 'v6.stages.building', reviewing: 'v6.stages.reviewing', ready: 'v6.stages.ready', live: 'v6.stages.live' };

function initialTab(): AppStudioTab {
  try {
    const value = window.localStorage.getItem(TAB_KEY) as AppStudioTab | null;
    return value && TAB_IDS.includes(value) ? value : 'plan';
  } catch { return 'plan'; }
}

export function AppStudioView({
  sessionId,
  initialMasterSessionId,
  initialIdeaPrompt,
  onBack,
}: {
  sessionId: number;
  initialMasterSessionId?: number;
  initialIdeaPrompt?: string | null;
  onBack: () => void;
}) {
  const { t } = useTranslation('appStudio');
  const { detail, error, refresh } = useAppStudioSession(sessionId);
  const [tab, setTabState] = useState<AppStudioTab>(initialTab);
  const [chatOpen, setChatOpen] = useState(() => !window.matchMedia('(max-width: 767px)').matches || !!initialIdeaPrompt?.trim());
  const [compact, setCompact] = useState(() => window.matchMedia('(max-width: 767px)').matches);
  const [action, setAction] = useState<'pause' | 'resume' | 'cancel' | null>(null);
  const panelRef = useRef<ImperativePanelHandle>(null);
  const setTab = (next: AppStudioTab) => { setTabState(next); try { window.localStorage.setItem(TAB_KEY, next); } catch { /* ignore */ } };

  useEffect(() => {
    const media = window.matchMedia('(max-width: 767px)');
    const update = () => setCompact(media.matches);
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);
  useEffect(() => { if (!compact) chatOpen ? panelRef.current?.expand() : panelRef.current?.collapse(); }, [chatOpen, compact]);

  const runControl = async (next: 'pause' | 'resume' | 'cancel') => {
    if (next === 'cancel' && !(await confirm({ title: t('v6.cancelTitle'), description: t('v6.cancelBody'), confirmLabel: t('v6.cancelBuild'), tone: 'destructive' }))) return;
    setAction(next);
    try { await runAppAction(sessionId, next); await refresh(); } finally { setAction(null); }
  };

  if (error && !detail) return <div className="space-y-3 p-6 text-sm"><p className="rounded border border-red-500/30 bg-red-500/10 p-3 text-red-700">{error}</p><Button variant="outline" size="sm" onClick={onBack}><ArrowLeft className="mr-1 h-4 w-4" />{t('backToApps')}</Button></div>;
  if (!detail?.project) return <div className="flex items-center gap-2 p-6 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />{t('create.creating')}</div>;

  const masterSessionId = detail.master_session_id ?? initialMasterSessionId ?? null;
  const right = <AppStudioRightPanel active="chat" appSessionId={sessionId} companySessionId={detail.session.company_session_id} projectId={detail.project.id} projectName={detail.project.name} masterSessionId={masterSessionId} initialPrompt={initialIdeaPrompt} onCollapse={() => setChatOpen(false)} />;
  const stageLabel = t(STAGE_KEYS[detail.stage]);

  return (
    <WorkbenchShell>
      <header className="flex h-9 shrink-0 items-center gap-2 border-b border-[var(--workbench-border)] bg-[var(--workbench-raised)] px-2">
        <Button variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={onBack}><ArrowLeft className="h-3.5 w-3.5 sm:mr-1" /><span className="hidden sm:inline">{t('backToApps')}</span></Button>
        <span className="h-4 w-px bg-[var(--workbench-border)]" />
        <div className="min-w-0 flex-1"><span className="truncate text-xs font-semibold">{detail.session.name}</span><span className="ml-2 rounded-full bg-primary/10 px-2 py-0.5 text-[11px] text-primary">{stageLabel}</span></div>
        {error && <span className="truncate text-xs text-red-600">{error}</span>}
        <Button variant="ghost" size="icon" className="h-7 w-7" disabled={action != null} onClick={() => void runControl('pause')} title={t('v6.pause')}><Pause className="h-3.5 w-3.5" /></Button>
        <Button variant="ghost" size="icon" className="h-7 w-7" disabled={action != null} onClick={() => void runControl('resume')} title={t('v6.resume')}><Play className="h-3.5 w-3.5" /></Button>
        <Button variant="ghost" size="icon" className="h-7 w-7 text-red-600" disabled={action != null} onClick={() => void runControl('cancel')} title={t('v6.cancelBuild')}><Square className="h-3.5 w-3.5" /></Button>
      </header>
      <div className="flex min-h-0 min-w-0 flex-1">
        <AppStudioRail active={tab} detail={detail} onSelect={setTab} />
        <div className="relative min-w-0 flex-1 p-1.5">
          <PanelGroup direction="horizontal" autoSaveId={`mcp-app-studio-v6-${sessionId}`} className="min-h-0 min-w-0">
            <Panel id="app-surface" order={1} defaultSize={compact ? 100 : 70} minSize={compact ? 100 : 48}>
              <WorkbenchSurface className="flex h-full min-h-0 flex-col"><AppStudioSurfaceFind key={tab}>{tab === 'app' ? <AppPreviewPanel projectId={detail.project.id} builderPort={detail.builder_port} onHide={() => setTab('plan')} /> : <AppStudioTabContent tab={tab} detail={detail} onChanged={() => void refresh()} />}</AppStudioSurfaceFind></WorkbenchSurface>
            </Panel>
            {!compact && <><WorkbenchResizeHandle direction="horizontal" disabled={!chatOpen} className={!chatOpen ? 'w-0 cursor-default' : undefined} /><Panel ref={panelRef} id="app-chat" order={2} defaultSize={chatOpen ? 30 : 0} minSize={22} maxSize={46} collapsible collapsedSize={0} onCollapse={() => setChatOpen(false)}><WorkbenchSurface className="h-full">{right}</WorkbenchSurface></Panel></>}
          </PanelGroup>
          {compact && chatOpen && <aside className="absolute inset-1.5 z-40 shadow-xl"><WorkbenchSurface className="h-full">{right}</WorkbenchSurface></aside>}
        </div>
        <AppStudioRightRail active={chatOpen ? 'chat' : null} onToggle={() => setChatOpen((open) => !open)} />
      </div>
      <StatusBarShell><span className={`h-1.5 w-1.5 rounded-full ${detail.stage === 'live' ? 'bg-emerald-500' : detail.stage === 'reviewing' ? 'bg-amber-400' : 'bg-violet-400'}`} /><span>{detail.session.name}</span><span className="opacity-40">·</span><span>{stageLabel}</span><MessageSquare className="ml-auto h-3 w-3" /></StatusBarShell>
    </WorkbenchShell>
  );
}
