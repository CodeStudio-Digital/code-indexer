/**
 * Right-side chat rail for App Studio.
 *
 * This is intentionally not the full AgentChat surface. The App Studio shell
 * owns the product stage; the rail only hosts the current conversation, the
 * session list, and the new-session action.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertCircle, ArrowLeft, Bot, Boxes, ChevronRight, Code2, Database, FolderPlus, Loader2, MessageSquare, Monitor, Palette, Plus, ShieldCheck, Workflow } from 'lucide-react';
import { Button } from '../../components/ui/button.js';
import { TooltipProvider } from '../../components/ui/tooltip.js';
import { confirm, prompt } from '../../components/ui/prompt-dialog.js';
import { MessageList } from '../chat/messages/MessageList.js';
import { Composer } from '../chat/composer/Composer.js';
import { QueuedMessages } from '../chat/composer/QueuedMessages.js';
import { SessionPickerDropdown } from '../project/editor-chat/SessionPickerDropdown.js';
import { useEditorChatSession } from '../project/editor-chat/useEditorChatSession.js';
import type { AppStudioSpecAgentConfig } from './AppStudioSpecAgentLauncher.js';

export type AppStudioChatMode = 'builder' | 'spec' | 'db' | 'architecture' | 'ux' | 'wireframe' | 'design' | 'backend' | 'review';

interface AppStudioChatRailProps {
  projectId: number;
  projectName: string;
  initialSessionId?: number;
  mode?: AppStudioChatMode;
  initialPrompt?: string | null;
  initialConfig?: AppStudioSpecAgentConfig | null;
  sessionTitle?: string;
  onInitialPromptConsumed?: () => void;
  onModeChange?: (mode: AppStudioChatMode) => void;
  onCollapse: () => void;
}

export function AppStudioChatRail({
  projectId,
  projectName,
  initialSessionId,
  mode = 'builder',
  initialPrompt,
  initialConfig,
  sessionTitle,
  onInitialPromptConsumed,
  onModeChange,
  onCollapse,
}: AppStudioChatRailProps) {
  const { t } = useTranslation(['appStudio', 'workspace', 'chat', 'common']);
  const pendingPromptRef = useRef<string | null>(null);
  const autoCreatedSpecialistRef = useRef(false);
  const [specialistStartError, setSpecialistStartError] = useState(false);
  const initialAgent = mode === 'spec'
    ? 'app_spec'
    : mode === 'db'
      ? 'app_db'
      : mode === 'architecture'
        ? 'app_architect'
        : mode === 'ux'
          ? 'app_ux'
          : mode === 'wireframe'
            ? 'app_wireframe'
        : mode === 'design'
          ? 'builder'
          : mode === 'backend' || mode === 'review'
            ? 'build'
            : 'builder';
  const s = useEditorChatSession(projectId, {
    initialSessionId,
    initialAgent,
    agentLock: mode === 'builder' ? undefined : initialAgent,
    includeEditorContext: false,
    selectionPrefixSessionId: projectId,
    initialProvider: initialConfig?.provider,
    initialModel: initialConfig?.model,
    initialThinking: initialConfig?.thinking,
    initialReasoningEffort: initialConfig?.reasoningEffort ?? null,
    newSessionTitle: sessionTitle ??
      (mode === 'spec'
        ? t('appStudio:chatRail.specSessionTitle', { name: projectName, defaultValue: `Refinar plano - ${projectName}` })
        : mode === 'db'
          ? t('appStudio:chatRail.dbSessionTitle', { name: projectName, defaultValue: `Analisar dados - ${projectName}` })
          : mode === 'architecture'
            ? t('appStudio:chatRail.architectureSessionTitle', { name: projectName, defaultValue: `Planejar construção - ${projectName}` })
          : mode === 'design'
            ? t('appStudio:chatRail.designSessionTitle', { name: projectName, defaultValue: `Montar telas - ${projectName}` })
          : mode === 'ux'
            ? t('appStudio:chatRail.uxSessionTitle', { name: projectName, defaultValue: `Direção UX - ${projectName}` })
          : mode === 'wireframe'
            ? t('appStudio:chatRail.wireframeSessionTitle', { name: projectName, defaultValue: `Fluxos e wireframes - ${projectName}` })
          : mode === 'backend'
            ? t('appStudio:chatRail.backendSessionTitle', { name: projectName, defaultValue: `Fazer funcionar - ${projectName}` })
          : mode === 'review'
            ? t('appStudio:chatRail.reviewSessionTitle', { name: projectName, defaultValue: `Revisar aplicação - ${projectName}` })
          : projectName),
  });

  useEffect(() => {
    if (initialPrompt?.trim()) pendingPromptRef.current = initialPrompt.trim();
  }, [initialPrompt]);

  useEffect(() => {
    if (mode === 'builder') {
      autoCreatedSpecialistRef.current = false;
      return;
    }
    if (s.selectedId != null || s.creating || autoCreatedSpecialistRef.current) return;
    autoCreatedSpecialistRef.current = true;
    setSpecialistStartError(false);
    void s.createSession().catch(() => {
      autoCreatedSpecialistRef.current = false;
      setSpecialistStartError(true);
    });
  }, [mode, s.selectedId, s.creating, s.createSession]);

  useEffect(() => {
    if (mode === 'builder' || !s.selectedId || s.streaming || !pendingPromptRef.current) return;
    const message = pendingPromptRef.current;
    pendingPromptRef.current = null;
    setSpecialistStartError(false);
    void s.handleSend(message, [])
      .then(() => onInitialPromptConsumed?.())
      .catch(() => {
        pendingPromptRef.current = message;
        setSpecialistStartError(true);
      });
  }, [mode, s.selectedId, s.streaming, s.handleSend, onInitialPromptConsumed]);

  const switchMode = () => onModeChange?.(mode === 'builder' ? 'spec' : 'builder');
  const modeToggle = onModeChange ? (
    <Button
      variant="ghost"
      size="icon"
      className="h-6 w-6 text-muted-foreground hover:text-foreground"
      onClick={switchMode}
      aria-label={
        mode !== 'builder'
          ? t('appStudio:chatRail.builderMode', { defaultValue: 'Chat de construcao' })
          : t('appStudio:chatRail.specMode', { defaultValue: 'Especialista em spec' })
      }
      title={
        mode !== 'builder'
          ? t('appStudio:chatRail.builderMode', { defaultValue: 'Chat de construcao' })
          : t('appStudio:chatRail.specMode', { defaultValue: 'Especialista em spec' })
      }
    >
      {mode === 'builder' ? <Bot className="h-3.5 w-3.5" /> : <MessageSquare className="h-3.5 w-3.5" />}
    </Button>
  ) : null;

  const createGroup = async () => {
    const name = await prompt({
      title: t('chat:newGroup'),
      description: t('chat:newGroupDescription'),
      placeholder: t('chat:groupNamePlaceholder'),
      confirmLabel: t('common:actions.create', { defaultValue: 'Criar' }),
    });
    if (!name) return;
    await s.createGroup(name);
  };

  const renameSession = async (id: number, currentTitle: string) => {
    const title = await prompt({
      title: t('chat:renameSession'),
      placeholder: t('chat:sessionNamePlaceholder'),
      defaultValue: currentTitle,
      confirmLabel: t('chat:sidebar.rename'),
    });
    if (!title || title.trim() === currentTitle.trim()) return;
    await s.renameSession(id, title);
  };

  const deleteSession = async (id: number) => {
    const ok = await confirm({
      title: t('chat:deleteSession'),
      description: t('chat:deleteSessionDescription'),
      confirmLabel: t('common:actions.delete', { defaultValue: 'Excluir' }),
      tone: 'destructive',
    });
    if (!ok) return;
    await s.deleteSession(id);
  };

  if (s.selectedId == null) {
    return (
      <div className="flex h-full min-h-0 flex-col bg-card">
        <RailHeader
          title={t('appStudio:chatRail.sessions', { defaultValue: 'Conversas' })}
          onClose={onCollapse}
          mode={mode}
          action={
            <>
              {modeToggle}
              <Button
                variant="ghost"
                size="icon"
                className="h-6 w-6 text-muted-foreground hover:text-foreground"
                onClick={() => void createGroup()}
                aria-label={t('chat:sidebar.newGroup')}
                title={t('chat:sidebar.newGroup')}
              >
                <FolderPlus className="h-3.5 w-3.5" />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                className="h-6 w-6 text-muted-foreground hover:text-foreground"
                onClick={() => void s.createSession()}
                disabled={s.creating}
                aria-label={t('workspace:chat.new')}
                title={t('workspace:chat.new')}
              >
                {s.creating ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-3.5 w-3.5" />}
              </Button>
            </>
          }
        />
        {specialistStartError && mode !== 'builder' ? (
          <div className="mx-2 mt-2 flex items-center gap-2 border border-destructive/30 bg-destructive/5 px-2 py-1.5 text-xs text-destructive">
            <AlertCircle className="h-3.5 w-3.5 shrink-0" />
            <span className="min-w-0 flex-1">{t('appStudio:chatRail.specialistStartError', { defaultValue: 'Nao foi possivel iniciar o especialista.' })}</span>
            <Button
              variant="ghost"
              size="sm"
              className="h-6 px-2 text-xs"
              onClick={() => {
                autoCreatedSpecialistRef.current = true;
                setSpecialistStartError(false);
                void s.createSession().catch(() => {
                  autoCreatedSpecialistRef.current = false;
                  setSpecialistStartError(true);
                });
              }}
            >
              {t('common:actions.retry', { defaultValue: 'Tentar novamente' })}
            </Button>
          </div>
        ) : null}
        <div className="flex-1 min-h-0">
          <SessionPickerDropdown
            projectName={projectName}
            sessions={s.sessions}
            groups={s.groups}
            onPick={s.setSelectedId}
            onFavorite={s.favoriteSession}
            onArchive={(id) => s.archiveSession(id, true)}
            onDelete={(id) => void deleteSession(id)}
            onRename={(id, title) => void renameSession(id, title)}
            onDuplicate={s.duplicateSession}
            onMoveToGroup={s.moveSessionToGroup}
          />
        </div>
      </div>
    );
  }

  return (
    <TooltipProvider delayDuration={300}>
      <div className="flex h-full min-h-0 flex-col bg-card">
        <RailHeader
          title={s.sessionData?.session.title ?? t('appStudio:chatRail.assistant', { defaultValue: 'Assistente' })}
          onBack={() => s.setSelectedId(null)}
          onClose={onCollapse}
          mode={mode}
          action={
            <>
              {modeToggle}
              <Button
                variant="ghost"
                size="icon"
                className="h-6 w-6 text-muted-foreground hover:text-foreground"
                onClick={() => void s.createSession()}
                disabled={s.creating}
                aria-label={t('workspace:chat.new')}
                title={t('workspace:chat.new')}
              >
                {s.creating ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-3.5 w-3.5" />}
              </Button>
            </>
          }
        />
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
          <MessageList
            sessionData={s.sessionData}
            currentTurn={s.currentTurn}
            streaming={s.streaming}
            doneReason={s.doneReason}
            error={s.error}
            liveTurnDuplicatedInHistory={s.liveTurnDuplicatedInHistory}
            persistedToolUseIds={s.persistedToolUseIds}
            fallbackProviderId={s.provider}
            tasksState={s.tasksState}
            handlers={s.handlers}
            onLoadEarlier={s.loadEarlierMessages}
            snapshotActions={s.snapshotActions}
            snapshotFiles={s.snapshotFiles}
          />
        </div>
        <Composer
          compact
          hideAgentPicker={mode !== 'builder'}
          agent={s.agent}
          setAgent={s.setAgent}
          provider={s.provider}
          model={s.model}
          setModel={s.setModel}
          onSwitchProvider={s.onSwitchProvider}
          onSend={s.handleSend}
          onAbort={s.abort}
          streaming={s.streaming}
          providerOptions={s.providerOptions}
          currentProviderModels={s.currentProviderModels}
          maxTurns={s.maxTurns}
          setMaxTurns={s.setMaxTurns}
          sessionId={s.selectedId}
          thinking={s.thinking}
          setThinking={s.setThinking}
          supportsThinking={s.supportsThinking}
          describeImages={s.describeImages}
          setDescribeImages={s.setDescribeImages}
          outputCapLevel={s.outputCapLevel}
          setOutputCapLevel={s.setOutputCapLevel}
          toolPermissionMode={s.toolPermissionMode}
          setToolPermissionMode={s.setToolPermissionMode}
          fallbackProvider={s.fallbackProvider}
          fallbackModel={s.fallbackModel}
          onFallbackChange={s.onFallbackChange}
          temperature={s.temperature}
          setTemperature={s.setTemperature}
          reasoningEffort={s.reasoningEffort}
          setReasoningEffort={s.setReasoningEffort}
          reasoningLevels={s.reasoningLevels}
          planDepth={s.planDepth}
          setPlanDepth={s.setPlanDepth}
          getModelsForProvider={s.getModelsForProvider}
          queueable={s.selectedId != null}
          onQueue={s.handleQueue}
          queuedStrip={<QueuedMessages items={s.queue.items} onPromote={s.queue.promote} onRemove={s.queue.remove} />}
        />
      </div>
    </TooltipProvider>
  );
}

function RailHeader({
  title,
  onBack,
  onClose,
  mode,
  action,
}: {
  title: string;
  onBack?: () => void;
  onClose: () => void;
  mode: AppStudioChatMode;
  action?: ReactNode;
}) {
  const { t } = useTranslation('appStudio');
  return (
    <header className="flex h-9 shrink-0 items-center gap-1.5 border-b bg-muted/20 px-2">
      {onBack && (
        <Button
          variant="ghost"
          size="icon"
          className="h-6 w-6 text-muted-foreground hover:text-foreground"
          onClick={onBack}
          aria-label={t('chatRail.back', { defaultValue: 'Voltar para conversas' })}
        >
          <ArrowLeft className="h-3.5 w-3.5" />
        </Button>
      )}
      {mode === 'spec' ? (
        <Bot className="h-3.5 w-3.5 shrink-0 text-primary" />
      ) : mode === 'db' ? (
        <Database className="h-3.5 w-3.5 shrink-0 text-primary" />
      ) : mode === 'architecture' ? (
        <Boxes className="h-3.5 w-3.5 shrink-0 text-primary" />
      ) : mode === 'design' ? (
        <Monitor className="h-3.5 w-3.5 shrink-0 text-primary" />
      ) : mode === 'ux' ? (
        <Palette className="h-3.5 w-3.5 shrink-0 text-primary" />
      ) : mode === 'wireframe' ? (
        <Workflow className="h-3.5 w-3.5 shrink-0 text-primary" />
      ) : mode === 'backend' ? (
        <Code2 className="h-3.5 w-3.5 shrink-0 text-primary" />
      ) : mode === 'review' ? (
        <ShieldCheck className="h-3.5 w-3.5 shrink-0 text-primary" />
      ) : (
        <MessageSquare className="h-3.5 w-3.5 shrink-0 text-primary" />
      )}
      <span className="min-w-0 flex-1 truncate text-xs font-semibold">{title}</span>
      {action}
      <Button
        variant="ghost"
        size="icon"
        className="h-6 w-6 text-muted-foreground hover:text-foreground"
        onClick={onClose}
        aria-label={t('chatRail.collapse', { defaultValue: 'Recolher chat' })}
      >
        <ChevronRight className="h-3.5 w-3.5" />
      </Button>
    </header>
  );
}
