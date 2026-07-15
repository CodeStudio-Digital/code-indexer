import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ArrowLeft, ChevronRight, History, Loader2, MessagesSquare, Plus } from 'lucide-react';
import { Button } from '../../components/ui/button.js';
import { TooltipProvider } from '../../components/ui/tooltip.js';
import { MessageList } from '../chat/messages/MessageList.js';
import { Composer } from '../chat/composer/Composer.js';
import { QueuedMessages } from '../chat/composer/QueuedMessages.js';
import { SessionPickerDropdown } from '../project/editor-chat/SessionPickerDropdown.js';
import { useEditorChatSession } from '../project/editor-chat/useEditorChatSession.js';
import { activateAppCoordinatorConversation } from './app-studio-api.js';
import { appStudioConversations } from './conversation-history.js';

export function AppStudioChatRail({
  appSessionId,
  projectId,
  projectName,
  coordinatorSessionId,
  initialPrompt,
  onCollapse,
  onCoordinatorChanged,
}: {
  appSessionId: number;
  projectId: number;
  projectName: string;
  coordinatorSessionId: number | null;
  initialPrompt?: string | null;
  onCollapse?: () => void;
  onCoordinatorChanged?: (coderSessionId: number) => void | Promise<void>;
}) {
  const { t } = useTranslation(['appStudio', 'chat']);
  const initialSent = useRef(false);
  const [showSessions, setShowSessions] = useState(false);
  const [changingConversation, setChangingConversation] = useState(false);
  const [conversationError, setConversationError] = useState<string | null>(null);
  const session = useEditorChatSession(projectId, {
    initialSessionId: coordinatorSessionId ?? undefined,
    initialAgent: 'app_orchestrator',
    agentLock: 'app_orchestrator',
    includeEditorContext: false,
    selectionPrefixSessionId: projectId,
    newSessionTitle: projectName,
  });
  const conversations = useMemo(
    () => appStudioConversations(session.sessions, coordinatorSessionId),
    [coordinatorSessionId, session.sessions],
  );
  const coordinatorBusy = session.streaming || session.sessionData?.session.status === 'running';
  const creatingConversation = changingConversation || session.creating;

  useEffect(() => {
    if (coordinatorSessionId) session.setSelectedId(coordinatorSessionId);
  }, [coordinatorSessionId, session.setSelectedId]);

  useEffect(() => {
    if (initialSent.current || !initialPrompt?.trim() || !session.selectedId || session.streaming) return;
    initialSent.current = true;
    void session.handleSend(
      `[App Studio] Ideia inicial do app: ${initialPrompt.trim()}\nConduza a fase Definir, atualize os cards e solicite apenas as decisões realmente necessárias.`,
      [],
    ).catch(() => { initialSent.current = false; });
  }, [initialPrompt, session.selectedId, session.streaming, session.handleSend]);

  const bindConversation = async (coderSessionId: number) => {
    const activeId = await activateAppCoordinatorConversation(appSessionId, coderSessionId);
    session.setSelectedId(activeId);
    setShowSessions(false);
    await onCoordinatorChanged?.(activeId);
  };

  const openConversation = async (coderSessionId: number) => {
    setConversationError(null);
    if (coderSessionId === coordinatorSessionId) {
      session.setSelectedId(coderSessionId);
      setShowSessions(false);
      return;
    }
    setChangingConversation(true);
    try {
      await bindConversation(coderSessionId);
    } catch (cause) {
      setConversationError((cause as Error).message);
    } finally {
      setChangingConversation(false);
    }
  };

  const createConversation = async () => {
    if (coordinatorBusy || creatingConversation) return;
    setConversationError(null);
    setChangingConversation(true);
    try {
      const createdId = await session.createSession();
      if (createdId == null) return;
      await bindConversation(createdId);
    } catch (cause) {
      if (coordinatorSessionId) session.setSelectedId(coordinatorSessionId);
      setShowSessions(true);
      setConversationError((cause as Error).message);
    } finally {
      setChangingConversation(false);
    }
  };

  const selectedTitle = session.sessionData?.session.id === session.selectedId
    ? session.sessionData.session.title
    : null;

  return (
    <TooltipProvider delayDuration={300}>
      <div className="flex h-full min-h-0 flex-col bg-[var(--workbench-surface)]">
        <header className="flex h-8 shrink-0 items-center gap-1 border-b border-[var(--workbench-border)] bg-[var(--workbench-raised)] px-1.5">
          <Button
            variant="ghost"
            size="icon"
            className="h-5 w-5"
            onClick={() => setShowSessions((current) => !current)}
            aria-label={showSessions ? t('appStudio:chatRail.backToConversation') : t('appStudio:chatRail.history')}
            title={showSessions ? t('appStudio:chatRail.backToConversation') : t('appStudio:chatRail.history')}
          >
            {showSessions ? <ArrowLeft className="h-3.5 w-3.5" /> : <History className="h-3.5 w-3.5" />}
          </Button>
          <MessagesSquare className="h-3.5 w-3.5 shrink-0 text-primary" />
          <span className="min-w-0 flex-1 truncate text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
            {showSessions ? t('appStudio:chatRail.sessions') : selectedTitle ?? t('appStudio:workflow.coordinator')}
          </span>
          <Button
            variant="ghost"
            size="icon"
            className="h-5 w-5"
            onClick={() => void createConversation()}
            disabled={coordinatorBusy || creatingConversation}
            aria-label={t('appStudio:chatRail.newConversation')}
            title={coordinatorBusy ? t('appStudio:chatRail.waitUntilIdle') : t('appStudio:chatRail.newConversation')}
          >
            {creatingConversation ? <Loader2 className="h-3 w-3 animate-spin" /> : <Plus className="h-3.5 w-3.5" />}
          </Button>
          {onCollapse && <Button variant="ghost" size="icon" className="h-5 w-5" onClick={onCollapse} aria-label={t('appStudio:chatRail.collapse')}>
            <ChevronRight className="h-3 w-3" />
          </Button>}
        </header>
        {conversationError && <div className="shrink-0 border-b border-red-500/30 bg-red-500/10 px-2 py-1.5 text-[10px] text-red-700">{conversationError}</div>}
        {showSessions ? (
          <div className="min-h-0 flex-1">
            <SessionPickerDropdown
              projectName={projectName}
              sessions={conversations}
              onPick={(id) => void openConversation(id)}
            />
          </div>
        ) : session.selectedId == null ? (
          <div className="flex min-h-0 flex-1 items-center justify-center gap-2 text-xs text-muted-foreground">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />{t('appStudio:workflow.connectingCoordinator')}
          </div>
        ) : (
          <>
            <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
              <MessageList
                sessionData={session.sessionData}
                currentTurn={session.currentTurn}
                streaming={session.streaming}
                doneReason={session.doneReason}
                error={session.error}
                liveTurnDuplicatedInHistory={session.liveTurnDuplicatedInHistory}
                persistedToolUseIds={session.persistedToolUseIds}
                fallbackProviderId={session.provider}
                tasksState={session.tasksState}
                handlers={session.handlers}
                onLoadEarlier={session.loadEarlierMessages}
                snapshotActions={session.snapshotActions}
                snapshotFiles={session.snapshotFiles}
              />
            </div>
            <Composer
              compact
              hideAgentPicker
              agent={session.agent}
              setAgent={session.setAgent}
              provider={session.provider}
              model={session.model}
              setModel={session.setModel}
              onSwitchProvider={session.onSwitchProvider}
              onSend={session.handleSend}
              onAbort={session.abort}
              streaming={session.streaming}
              providerOptions={session.providerOptions}
              currentProviderModels={session.currentProviderModels}
              maxTurns={session.maxTurns}
              setMaxTurns={session.setMaxTurns}
              sessionId={session.selectedId}
              thinking={session.thinking}
              setThinking={session.setThinking}
              supportsThinking={session.supportsThinking}
              describeImages={session.describeImages}
              setDescribeImages={session.setDescribeImages}
              outputCapLevel={session.outputCapLevel}
              setOutputCapLevel={session.setOutputCapLevel}
              toolPermissionMode={session.toolPermissionMode}
              setToolPermissionMode={session.setToolPermissionMode}
              fallbackProvider={session.fallbackProvider}
              fallbackModel={session.fallbackModel}
              onFallbackChange={session.onFallbackChange}
              temperature={session.temperature}
              setTemperature={session.setTemperature}
              reasoningEffort={session.reasoningEffort}
              setReasoningEffort={session.setReasoningEffort}
              reasoningLevels={session.reasoningLevels}
              planDepth={session.planDepth}
              setPlanDepth={session.setPlanDepth}
              getModelsForProvider={session.getModelsForProvider}
              queueable
              onQueue={session.handleQueue}
              queuedStrip={<QueuedMessages items={session.queue.items} onPromote={session.queue.promote} onRemove={session.queue.remove} />}
            />
          </>
        )}
      </div>
    </TooltipProvider>
  );
}
