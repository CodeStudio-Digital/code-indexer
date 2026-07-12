/**
 * App Studio — workbench guiado para leigos: rail de ferramentas à esquerda,
 * palco principal no centro (Preview / Mapa / Dados / Publicar) e conversa
 * compacta à direita. A conversa deixa de ser a superfície dominante; ela é
 * a "pessoa do lado" enquanto o usuário constrói no palco.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { Panel, PanelGroup, PanelResizeHandle } from 'react-resizable-panels';
import { ArrowLeft, ListChecks, Loader2, MessageSquare, Play, Rocket, Wrench } from 'lucide-react';
import { Button } from '../../components/ui/button.js';
import { Tooltip, TooltipContent, TooltipTrigger } from '../../components/ui/tooltip.js';
import { confirm } from '../../components/ui/prompt-dialog.js';
import type { AppStageId, AppStudioSessionDetail } from './app-studio-api.js';
import { useAppStudioSession } from './useAppStudioSession.js';
import { AppStudioRail, AppStudioTabContent, type AppStudioTab } from './AppStudioRail.js';
import { AppPreviewPanel } from './preview/AppPreviewPanel.js';
import { activateAppStage, isPromptableStage, specialistForStage, stagePrompt, startAppStage } from './stage-prompts.js';
import { AppStudioChatRail, type AppStudioChatMode } from './AppStudioChatRail.js';
import { AppStudioSurfaceFind } from './AppStudioSurfaceFind.js';
import { isStageApprovalBlocked } from './stage-review-state.js';
import {
  AppStudioSpecAgentLauncher,
  type AppStudioSpecAgentConfig,
} from './AppStudioSpecAgentLauncher.js';

const TAB_STORAGE_KEY = 'mcp.app-studio.tab';
const ADVANCED_SEEN_KEY = 'mcp.app-studio.advanced-seen';
const TAB_IDS: AppStudioTab[] = ['guide', 'product', 'blueprint', 'versions', 'architecture', 'experience', 'preview', 'data', 'publish'];
type StageLaunchKind = 'product' | 'ux' | 'wireframe' | 'design' | 'backend' | 'review';

/** Aba sugerida por etapa (auto-switch one-shot em transição de etapa). */
const STAGE_TAB: Record<AppStageId, AppStudioTab> = {
  discovery: 'guide',
  product: 'product',
  architecture: 'architecture',
  database: 'data',
  ux: 'experience',
  wireframe: 'experience',
  design: 'experience',
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
  const [compact, setCompact] = useState(() => window.matchMedia('(max-width: 767px)').matches);
  const [chatCollapsed, setChatCollapsed] = useState(() => window.matchMedia('(max-width: 767px)').matches);
  const [chatMode, setChatMode] = useState<AppStudioChatMode>('builder');
  const [pendingSpecPrompt, setPendingSpecPrompt] = useState<string | null>(null);
  const [specLaunchPrompt, setSpecLaunchPrompt] = useState<string | null>(null);
  const [specAgentConfig, setSpecAgentConfig] = useState<AppStudioSpecAgentConfig | null>(null);
  const [specLaunchId, setSpecLaunchId] = useState(0);
  const [pendingDbPrompt, setPendingDbPrompt] = useState<string | null>(null);
  const [dbLaunchPrompt, setDbLaunchPrompt] = useState<string | null>(null);
  const [dbAgentConfig, setDbAgentConfig] = useState<AppStudioSpecAgentConfig | null>(null);
  const [dbLaunchId, setDbLaunchId] = useState(0);
  const [pendingArchitecturePrompt, setPendingArchitecturePrompt] = useState<string | null>(null);
  const [architectureLaunchPrompt, setArchitectureLaunchPrompt] = useState<string | null>(null);
  const [architectureAgentConfig, setArchitectureAgentConfig] = useState<AppStudioSpecAgentConfig | null>(null);
  const [architectureLaunchId, setArchitectureLaunchId] = useState(0);
  const [executionLaunch, setExecutionLaunch] = useState<{
    kind: StageLaunchKind;
    prompt: string;
  } | null>(null);
  const [executionMode, setExecutionMode] = useState<StageLaunchKind>('design');
  const [pendingExecutionPrompt, setPendingExecutionPrompt] = useState<string | null>(null);
  const [executionAgentConfig, setExecutionAgentConfig] = useState<AppStudioSpecAgentConfig | null>(null);
  const [executionLaunchId, setExecutionLaunchId] = useState(0);
  const lastAutoSwitched = useRef<AppStageId | null>(null);

  useEffect(() => {
    const media = window.matchMedia('(max-width: 767px)');
    const update = () => {
      setCompact(media.matches);
      if (media.matches) setChatCollapsed(true);
    };
    update();
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);

  // Auto-switch de aba quando a ETAPA corrente muda (one-shot por etapa —
  // nunca briga com escolha manual dentro da mesma etapa).
  const currentStageId = detail?.pipeline?.current_stage ?? null;
  useEffect(() => {
    if (!currentStageId || lastAutoSwitched.current === currentStageId) return;
    if (lastAutoSwitched.current !== null) setActiveTab(STAGE_TAB[currentStageId]);
    lastAutoSwitched.current = currentStageId;
  }, [currentStageId, setActiveTab]);

  const openPublish = useCallback(() => setActiveTab('publish'), [setActiveTab]);
  const openSpecAgent = useCallback((prompt: string) => {
    setSpecLaunchPrompt(prompt);
  }, []);
  const openDbAgent = useCallback((prompt: string) => {
    setDbLaunchPrompt(prompt);
  }, []);
  const openArchitectureAgent = useCallback((prompt: string) => {
    setArchitectureLaunchPrompt(prompt);
  }, []);
  const openGuidedStageAgent = useCallback((kind: StageLaunchKind, prompt: string) => {
    setExecutionLaunch({ kind, prompt });
  }, []);
  const openExecutionAgent = useCallback((kind: 'design' | 'backend' | 'review', prompt: string) => openGuidedStageAgent(kind, prompt), [openGuidedStageAgent]);
  const openProductAgent = useCallback((prompt: string) => openGuidedStageAgent('product', prompt), [openGuidedStageAgent]);
  const openUxAgent = useCallback((prompt: string) => openGuidedStageAgent('ux', prompt), [openGuidedStageAgent]);
  const openWireframeAgent = useCallback((prompt: string) => openGuidedStageAgent('wireframe', prompt), [openGuidedStageAgent]);
  const openStageSpecialist = useCallback((stage: AppStageId, prompt: string): boolean => {
    const specialist = specialistForStage(stage);
    if (specialist === 'spec') openSpecAgent(prompt);
    else if (specialist === 'product') openProductAgent(prompt);
    else if (specialist === 'db') openDbAgent(prompt);
    else if (specialist === 'architecture') openArchitectureAgent(prompt);
    else if (specialist === 'ux') openUxAgent(prompt);
    else if (specialist === 'wireframe') openWireframeAgent(prompt);
    else if (specialist === 'design' || specialist === 'backend' || specialist === 'review') {
      openExecutionAgent(specialist, prompt);
    }
    else return false;
    return true;
  }, [openArchitectureAgent, openDbAgent, openExecutionAgent, openProductAgent, openSpecAgent, openUxAgent, openWireframeAgent]);
  const launchSpecAgent = useCallback((config: AppStudioSpecAgentConfig) => {
    if (specLaunchPrompt === null) return;
    setSpecAgentConfig(config);
    setChatMode('spec');
    setPendingSpecPrompt(specLaunchPrompt.trim() ? specLaunchPrompt : null);
    setSpecLaunchId((n) => n + 1);
    setChatCollapsed(false);
    setSpecLaunchPrompt(null);
  }, [specLaunchPrompt]);
  const launchDbAgent = useCallback((config: AppStudioSpecAgentConfig) => {
    if (dbLaunchPrompt === null) return;
    setDbAgentConfig(config);
    setChatMode('db');
    setPendingDbPrompt(dbLaunchPrompt.trim() ? dbLaunchPrompt : null);
    setDbLaunchId((n) => n + 1);
    setChatCollapsed(false);
    setDbLaunchPrompt(null);
  }, [dbLaunchPrompt]);
  const launchArchitectureAgent = useCallback((config: AppStudioSpecAgentConfig) => {
    if (architectureLaunchPrompt === null) return;
    setArchitectureAgentConfig(config);
    setChatMode('architecture');
    setPendingArchitecturePrompt(architectureLaunchPrompt.trim() ? architectureLaunchPrompt : null);
    setArchitectureLaunchId((n) => n + 1);
    setChatCollapsed(false);
    setArchitectureLaunchPrompt(null);
  }, [architectureLaunchPrompt]);
  const launchExecutionAgent = useCallback((config: AppStudioSpecAgentConfig) => {
    if (!executionLaunch) return;
    setExecutionAgentConfig(config);
    setExecutionMode(executionLaunch.kind);
    setChatMode(executionLaunch.kind);
    setPendingExecutionPrompt(executionLaunch.prompt.trim() ? executionLaunch.prompt : null);
    setExecutionLaunchId((n) => n + 1);
    setChatCollapsed(false);
    setExecutionLaunch(null);
  }, [executionLaunch]);
  const handleChatModeChange = useCallback((next: AppStudioChatMode) => {
    if (next === 'spec') {
      setSpecLaunchPrompt('');
      return;
    }
    if (next === 'db') {
      setDbLaunchPrompt('');
      return;
    }
    if (next === 'architecture') {
      setArchitectureLaunchPrompt('');
      return;
    }
    setChatMode('builder');
  }, []);

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
  const studioTab = activeTab ?? 'preview';
  const pipeline = detail.pipeline;
  const currentStage = pipeline?.stages.find((s) => s.id === pipeline.current_stage) ?? null;
  const currentStageIndex = currentStage && pipeline
    ? pipeline.stages.findIndex((s) => s.id === currentStage.id)
    : -1;
  const approvalBlocked = isStageApprovalBlocked(currentStage);
  const stageAction = currentStage && project
    ? currentStage.status === 'review'
      ? {
          icon: ListChecks,
          label: t('pipeline.reviewCta'),
          onClick: () => setActiveTab('guide'),
          variant: 'outline' as const,
        }
      : currentStage.status === 'pending' || currentStage.status === 'active'
        ? {
            icon: currentStage.id === 'launch' ? Rocket : Play,
            label: currentStage.id === 'launch'
              ? t('tabs.publish')
              : approvalBlocked
                ? t('pipeline.resolvePending')
              : currentStage.status === 'pending'
                ? t('pipeline.start')
                : t('pipeline.resend'),
            onClick: () => {
              if (currentStage.id === 'launch' || !isPromptableStage(currentStage.id)) {
                openPublish();
                return;
              }
              const prompt = stagePrompt(t, currentStage.id, currentStage.id === 'discovery' ? discoveryExtra : null);
              if (specialistForStage(currentStage.id)) {
                void activateAppStage(session.id, currentStage.id).then(() => {
                  openStageSpecialist(currentStage.id, prompt);
                  void refresh();
                });
                return;
              }
              void startAppStage(t, {
                sessionId: session.id,
                projectId: project.id,
                stage: currentStage.id,
                extra: currentStage.id === 'discovery' ? discoveryExtra : null,
              }).then(() => void refresh());
            },
            variant: 'default' as const,
          }
        : null
    : null;
  const stageTooltip = stageAction && currentStage && pipeline
    ? `${stageAction.label} · ${t('pipeline.stageOf', { n: currentStageIndex + 1, total: pipeline.stages.length })} · ${t(`stages.${currentStage.id}.name`)}`
    : '';
  const chatRail = (
    <AppStudioChatRail
      key={chatMode === 'spec'
        ? `spec-${specLaunchId}`
        : chatMode === 'db'
          ? `db-${dbLaunchId}`
          : chatMode === 'architecture'
            ? `architecture-${architectureLaunchId}`
            : chatMode === 'product' || chatMode === 'ux' || chatMode === 'wireframe' || chatMode === 'design' || chatMode === 'backend' || chatMode === 'review'
              ? `${chatMode}-${executionLaunchId}`
              : 'builder'}
      projectId={project.id}
      projectName={project.name}
      initialSessionId={chatMode === 'builder' ? initialCoderSessionId : undefined}
      mode={chatMode}
      initialPrompt={chatMode === 'spec' ? pendingSpecPrompt : chatMode === 'db' ? pendingDbPrompt : chatMode === 'architecture' ? pendingArchitecturePrompt : chatMode === 'product' || chatMode === 'ux' || chatMode === 'wireframe' || chatMode === 'design' || chatMode === 'backend' || chatMode === 'review' ? pendingExecutionPrompt : null}
      initialConfig={chatMode === 'spec' ? specAgentConfig : chatMode === 'db' ? dbAgentConfig : chatMode === 'architecture' ? architectureAgentConfig : chatMode === 'product' || chatMode === 'ux' || chatMode === 'wireframe' || chatMode === 'design' || chatMode === 'backend' || chatMode === 'review' ? executionAgentConfig : null}
      onInitialPromptConsumed={() => {
        if (chatMode === 'spec') setPendingSpecPrompt(null);
        if (chatMode === 'db') setPendingDbPrompt(null);
        if (chatMode === 'architecture') setPendingArchitecturePrompt(null);
        if (chatMode === 'product' || chatMode === 'ux' || chatMode === 'wireframe' || chatMode === 'design' || chatMode === 'backend' || chatMode === 'review') setPendingExecutionPrompt(null);
      }}
      onModeChange={handleChatModeChange}
      onCollapse={() => setChatCollapsed(true)}
    />
  );

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex h-11 shrink-0 items-center gap-3 border-b bg-background px-3">
        <Button variant="ghost" size="sm" className="shrink-0 px-2 sm:px-3" onClick={onBack} aria-label={t('backToApps')}>
          <ArrowLeft className="h-4 w-4 sm:mr-1" /> <span className="hidden sm:inline">{t('backToApps')}</span>
        </Button>
        <div className="min-w-0 flex-1">
          <span className="font-semibold">{session.name}</span>
          <span className={`ml-2 rounded-full px-2 py-0.5 text-[11px] ${chip.cls}`}>{chip.label}</span>
        </div>
        {error && <span className="truncate text-xs text-red-600">{error}</span>}
        {stageAction && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant={stageAction.variant}
                size="icon"
                className="h-8 w-8"
                onClick={stageAction.onClick}
                aria-label={stageTooltip}
              >
                <stageAction.icon className="h-4 w-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">{stageTooltip}</TooltipContent>
          </Tooltip>
        )}
        <Button variant="ghost" size="sm" className="shrink-0 px-2 text-xs text-muted-foreground sm:px-3" onClick={() => void openAdvanced()} aria-label={t('advanced.label')}>
          <Wrench className="h-3.5 w-3.5 sm:mr-1" /> <span className="hidden sm:inline">{t('advanced.label')}</span>
        </Button>
      </header>

      <div className="relative flex min-h-0 min-w-0 flex-1 bg-background">
        <AppStudioSpecAgentLauncher
          kind="spec"
          open={specLaunchPrompt !== null}
          onOpenChange={(open) => {
            if (!open) setSpecLaunchPrompt(null);
          }}
          onLaunch={launchSpecAgent}
        />
        <AppStudioSpecAgentLauncher
          kind="db"
          open={dbLaunchPrompt !== null}
          onOpenChange={(open) => {
            if (!open) setDbLaunchPrompt(null);
          }}
          onLaunch={launchDbAgent}
        />
        <AppStudioSpecAgentLauncher
          kind="architecture"
          open={architectureLaunchPrompt !== null}
          onOpenChange={(open) => {
            if (!open) setArchitectureLaunchPrompt(null);
          }}
          onLaunch={launchArchitectureAgent}
        />
        <AppStudioSpecAgentLauncher
          kind={executionLaunch?.kind ?? executionMode}
          open={executionLaunch !== null}
          onOpenChange={(open) => {
            if (!open) setExecutionLaunch(null);
          }}
          onLaunch={launchExecutionAgent}
        />
        <AppStudioRail
          active={studioTab}
          detail={detail}
          onSelect={(tab) => setActiveTab(tab)}
        />
        <PanelGroup direction="horizontal" autoSaveId="mcp-app-studio-stage-chat" className="min-h-0 min-w-0 flex-1">
          <Panel id="app-stage" order={1} defaultSize={compact || chatCollapsed ? 100 : 72} minSize={compact ? 100 : 48}>
            <main className="flex h-full min-h-0 flex-col">
              <div className="min-h-0 flex-1 overflow-hidden">
                <AppStudioSurfaceFind key={studioTab}>
                  {studioTab === 'preview' ? (
                    <AppPreviewPanel
                      projectId={project.id}
                      builderPort={builderPort}
                      onHide={() => setActiveTab(detail.spec ? 'blueprint' : 'guide')}
                    />
                  ) : (
                    <AppStudioTabContent
                      tab={studioTab}
                      detail={detail}
                      discoveryExtra={discoveryExtra}
                      onChanged={() => void refresh()}
                      onOpenPublish={openPublish}
                      onOpenSpecAgent={openSpecAgent}
                      onOpenDbAgent={openDbAgent}
                      onOpenArchitectureAgent={openArchitectureAgent}
                      onOpenProductAgent={openProductAgent}
                      onOpenProductRepair={() => setActiveTab('guide')}
                      onOpenExecutionAgent={openExecutionAgent}
                      onOpenUxAgent={openUxAgent}
                      onOpenWireframeAgent={openWireframeAgent}
                    />
                  )}
                </AppStudioSurfaceFind>
              </div>
            </main>
          </Panel>
          {!compact && !chatCollapsed && (
            <>
              <PanelResizeHandle className="w-px bg-border transition-colors hover:bg-primary/40" />
              <Panel id="app-chat-rail" order={2} defaultSize={28} minSize={20} maxSize={42} className="min-w-[320px]">
                {chatRail}
              </Panel>
            </>
          )}
        </PanelGroup>
        {compact && !chatCollapsed && (
          <aside className="absolute inset-y-0 left-11 right-0 z-40 bg-background shadow-xl">
            {chatRail}
          </aside>
        )}
        {chatCollapsed && (
          <nav
            className="flex w-11 shrink-0 flex-col items-center gap-0.5 border-l bg-card/45 py-1.5"
            aria-label={t('chatRail.open', { defaultValue: 'Abrir chat' })}
          >
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  onClick={() => setChatCollapsed(false)}
                  className="relative grid h-8 w-8 place-items-center rounded-md bg-accent text-accent-foreground shadow-sm transition-colors hover:bg-accent/90"
                  aria-label={t('chatRail.open', { defaultValue: 'Abrir chat' })}
                  aria-current="page"
                >
                  <MessageSquare className="h-4 w-4" />
                  <span aria-hidden className="absolute -right-1 top-1.5 bottom-1.5 w-0.5 rounded-full bg-primary" />
                </button>
              </TooltipTrigger>
              <TooltipContent side="left">{t('chatRail.open', { defaultValue: 'Abrir chat' })}</TooltipContent>
            </Tooltip>
          </nav>
        )}
      </div>
    </div>
  );
}
