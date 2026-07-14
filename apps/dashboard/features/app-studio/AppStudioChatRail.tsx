import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronRight, Loader2, MessagesSquare } from 'lucide-react';
import { Button } from '../../components/ui/button.js';
import { TooltipProvider } from '../../components/ui/tooltip.js';
import { MessageList } from '../chat/messages/MessageList.js';
import { Composer } from '../chat/composer/Composer.js';
import { QueuedMessages } from '../chat/composer/QueuedMessages.js';
import { useEditorChatSession } from '../project/editor-chat/useEditorChatSession.js';

export function AppStudioChatRail({
  projectId,
  projectName,
  coordinatorSessionId,
  initialPrompt,
  onCollapse,
  showHeader = true,
}: {
  projectId: number;
  projectName: string;
  coordinatorSessionId: number | null;
  initialPrompt?: string | null;
  onCollapse?: () => void;
  showHeader?: boolean;
}) {
  const { t } = useTranslation(['appStudio', 'chat']);
  const initialSent = useRef(false);
  const session = useEditorChatSession(projectId, {
    initialSessionId: coordinatorSessionId ?? undefined,
    initialAgent: 'app_orchestrator',
    agentLock: 'app_orchestrator',
    includeEditorContext: false,
    selectionPrefixSessionId: projectId,
    newSessionTitle: projectName,
  });

  useEffect(() => {
    if (coordinatorSessionId && session.selectedId !== coordinatorSessionId) session.setSelectedId(coordinatorSessionId);
  }, [coordinatorSessionId, session.selectedId, session.setSelectedId]);

  useEffect(() => {
    if (initialSent.current || !initialPrompt?.trim() || !session.selectedId || session.streaming) return;
    initialSent.current = true;
    void session.handleSend(
      `[App Studio] Ideia inicial do app: ${initialPrompt.trim()}\nConduza a fase Definir, atualize os cards e solicite apenas as decisões realmente necessárias.`,
      [],
    ).catch(() => { initialSent.current = false; });
  }, [initialPrompt, session.selectedId, session.streaming, session.handleSend]);

  return (
    <TooltipProvider delayDuration={300}>
      <div className="flex h-full min-h-0 flex-col bg-[var(--workbench-surface)]">
        {showHeader && <header className="flex h-8 shrink-0 items-center gap-1 border-b border-[var(--workbench-border)] bg-[var(--workbench-raised)] px-1.5">
          <MessagesSquare className="h-3.5 w-3.5 shrink-0 text-primary" />
          <span className="min-w-0 flex-1 truncate text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
            {t('appStudio:workflow.coordinator')}
          </span>
          {onCollapse && <Button variant="ghost" size="icon" className="h-5 w-5" onClick={onCollapse} aria-label={t('appStudio:chatRail.collapse')}>
            <ChevronRight className="h-3 w-3" />
          </Button>}
        </header>}
        {!coordinatorSessionId || session.selectedId == null ? (
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
