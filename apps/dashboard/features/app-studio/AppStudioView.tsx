/**
 * App Studio — a tela do app guiado para leigos: chat (a "pessoa do lado")
 * | painel de conteúdo (Guia / Seu app / Seus dados / Publicar) | rail
 * rotulado. Clone estrutural do DsStudioView, preservando o invariante:
 * o Panel do chat é SEMPRE o primeiro filho do mesmo PanelGroup (o
 * AgentChat nunca desmonta ao trocar de aba).
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { Panel, PanelGroup, PanelResizeHandle } from 'react-resizable-panels';
import { ArrowLeft, Loader2, Wrench } from 'lucide-react';
import { Button } from '../../components/ui/button.js';
import { confirm } from '../../components/ui/prompt-dialog.js';
import AgentChat from '../chat/index.js';
import type { AppStageId, AppStudioSessionDetail } from './app-studio-api.js';
import { useAppStudioSession } from './useAppStudioSession.js';
import { AppStudioRail, AppStudioTabContent, type AppStudioTab } from './AppStudioRail.js';
import { AppPreviewPanel } from './preview/AppPreviewPanel.js';
import { GuideBar } from './GuideBar.js';
import { startAppStage } from './stage-prompts.js';

const TAB_STORAGE_KEY = 'mcp.app-studio.tab';
const ADVANCED_SEEN_KEY = 'mcp.app-studio.advanced-seen';
const TAB_IDS: AppStudioTab[] = ['guide', 'blueprint', 'preview', 'data', 'publish'];

/** Aba sugerida por etapa (auto-switch one-shot em transição de etapa). */
const STAGE_TAB: Record<AppStageId, AppStudioTab> = {
  discovery: 'guide',
  database: 'data',
  design: 'preview',
  backend: 'preview',
  review: 'preview',
  launch: 'publish',
};

function usePersistedTab(): [AppStudioTab | null, (t: AppStudioTab | null) => void] {
  const [value, setValue] = useState<AppStudioTab | null>(() => {
    try {
      const raw = window.localStorage.getItem(TAB_STORAGE_KEY);
      if (raw === 'none') return null;
      return TAB_IDS.includes(raw as AppStudioTab) ? (raw as AppStudioTab) : 'guide';
    } catch {
      return 'guide';
    }
  });
  const set = useCallback((t: AppStudioTab | null) => {
    setValue(t);
    try {
      window.localStorage.setItem(TAB_STORAGE_KEY, t ?? 'none');
    } catch {
      /* ignore */
    }
  }, []);
  return [value, set];
}

function statusChip(detail: AppStudioSessionDetail, t: (k: string, o?: object) => string): { label: string; cls: string } {
  if (detail.deploy?.url) return { label: t('home.status.live'), cls: 'bg-green-500/15 text-green-600' };
  const pipeline = detail.pipeline;
  const current = pipeline?.stages.find((s) => s.id === pipeline.current_stage);
  if (!current) return { label: t('home.status.done'), cls: 'bg-green-500/15 text-green-600' };
  if (current.status === 'review') return { label: t('home.status.review'), cls: 'bg-amber-500/15 text-amber-600' };
  const n = pipeline!.stages.findIndex((s) => s.id === current.id) + 1;
  return {
    label: t('home.status.building', { n, total: pipeline!.stages.length }),
    cls: 'bg-primary/10 text-primary',
  };
}

export function AppStudioView({
  sessionId,
  initialCoderSessionId,
  discoveryExtra,
  onBack,
}: {
  sessionId: number;
  /** Setado logo após a criação para abrir a sessão de chat recém-criada. */
  initialCoderSessionId?: number;
  /** Frase de ideia digitada na criação (anexada ao prompt da discovery). */
  discoveryExtra?: string | null;
  onBack: () => void;
}) {
  const { t } = useTranslation('appStudio');
  const navigate = useNavigate();
  const { detail, error, refresh } = useAppStudioSession(sessionId);
  const [activeTab, setActiveTab] = usePersistedTab();
  const lastAutoSwitched = useRef<AppStageId | null>(null);

  // Auto-switch de aba quando a ETAPA corrente muda (one-shot por etapa —
  // nunca briga com escolha manual dentro da mesma etapa).
  const currentStageId = detail?.pipeline?.current_stage ?? null;
  useEffect(() => {
    if (!currentStageId || lastAutoSwitched.current === currentStageId) return;
    if (lastAutoSwitched.current !== null) setActiveTab(STAGE_TAB[currentStageId]);
    lastAutoSwitched.current = currentStageId;
  }, [currentStageId, setActiveTab]);

  const openPublish = useCallback(() => setActiveTab('publish'), [setActiveTab]);

  // Entrevista automática: app recém-criado (initialCoderSessionId setado)
  // com discovery ainda pending → dispara o prompt sozinho, sem o leigo
  // precisar achar o botão "Começar etapa". One-shot por mount.
  const autoFired = useRef(false);
  useEffect(() => {
    if (autoFired.current || !initialCoderSessionId || !detail?.project) return;
    const discovery = detail.pipeline?.stages.find((s) => s.id === 'discovery');
    if (discovery?.status !== 'pending') return;
    autoFired.current = true;
    void startAppStage(t, {
      sessionId,
      projectId: detail.project.id,
      stage: 'discovery',
      extra: discoveryExtra,
    }).then(() => void refresh());
  }, [detail, initialCoderSessionId, discoveryExtra, sessionId, t, refresh]);

  async function openAdvanced() {
    if (!detail?.project) return;
    let seen = false;
    try {
      seen = window.localStorage.getItem(ADVANCED_SEEN_KEY) === '1';
    } catch {
      /* ignore */
    }
    if (!seen) {
      const go = await confirm({
        title: t('advanced.confirmTitle'),
        description: t('advanced.confirmBody'),
        confirmLabel: t('advanced.confirm'),
      });
      if (!go) return;
      try {
        window.localStorage.setItem(ADVANCED_SEEN_KEY, '1');
      } catch {
        /* ignore */
      }
    }
    navigate(`/projects/${detail.project.id}`);
  }

  if (error && !detail) {
    return (
      <div className="space-y-3 p-6 text-sm">
        <div className="rounded border border-red-300 bg-red-50 p-3 text-red-800">{error}</div>
        <Button variant="outline" size="sm" onClick={onBack}>
          <ArrowLeft className="mr-1 h-4 w-4" /> {t('backToApps')}
        </Button>
      </div>
    );
  }
  if (!detail || !detail.project) {
    return (
      <div className="flex items-center gap-2 p-6 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" /> {t('create.creating')}
      </div>
    );
  }

  const { session, project, builder_port: builderPort } = detail;
  const chip = statusChip(detail, t as never);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex h-12 shrink-0 items-center gap-3 border-b px-3">
        <Button variant="ghost" size="sm" onClick={onBack}>
          <ArrowLeft className="mr-1 h-4 w-4" /> {t('backToApps')}
        </Button>
        <div className="min-w-0 flex-1">
          <span className="font-semibold">{session.name}</span>
          <span className={`ml-2 rounded-full px-2 py-0.5 text-[11px] ${chip.cls}`}>{chip.label}</span>
        </div>
        {error && <span className="truncate text-xs text-red-600">{error}</span>}
        <Button variant="ghost" size="sm" className="text-xs text-muted-foreground" onClick={() => void openAdvanced()}>
          <Wrench className="mr-1 h-3.5 w-3.5" /> {t('advanced.label')}
        </Button>
      </header>

      <div className="flex min-h-0 flex-1">
        <PanelGroup direction="horizontal" autoSaveId="mcp-app-studio-horiz" className="min-h-0 flex-1">
          <Panel id="app-chat" order={1} defaultSize={activeTab ? 45 : 100} minSize={26}>
            <div className="flex h-full min-h-0 flex-col">
              <GuideBar
                detail={detail}
                discoveryExtra={discoveryExtra}
                onOpenGuide={() => setActiveTab('guide')}
                onOpenPublish={openPublish}
                onChanged={() => void refresh()}
              />
              <div className="min-h-0 flex-1">
                {/* Picker de agente VISÍVEL (pedido do usuário): a sessão nasce
                    'builder' e o composer hidrata/mostra isso — mas se algo
                    rebaixar o modo (bug antigo: primeiro envio mandava
                    'explore'), o usuário consegue voltar pra Builder aqui em
                    vez de ficar preso num agente read-only. */}
                <AgentChat
                  projectId={project.id}
                  projectName={project.name}
                  initialSessionId={initialCoderSessionId}
                  selectionPrefixSessionId={project.id}
                />
              </div>
            </div>
          </Panel>
          {activeTab && (
            <>
              <PanelResizeHandle className="w-px bg-border transition-colors hover:bg-primary/40" />
              <Panel id="app-content" order={2} defaultSize={55} minSize={24}>
                {activeTab === 'preview' ? (
                  <AppPreviewPanel projectId={project.id} builderPort={builderPort} onHide={() => setActiveTab(null)} />
                ) : (
                  <AppStudioTabContent
                    tab={activeTab}
                    detail={detail}
                    discoveryExtra={discoveryExtra}
                    onChanged={() => void refresh()}
                    onOpenPublish={openPublish}
                  />
                )}
              </Panel>
            </>
          )}
        </PanelGroup>
        <AppStudioRail
          active={activeTab}
          detail={detail}
          onSelect={(tab) => setActiveTab(activeTab === tab ? null : tab)}
        />
      </div>
    </div>
  );
}
