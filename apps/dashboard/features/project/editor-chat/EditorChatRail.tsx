/**
 * Copilot-style chat rail docked beside the Monaco editor (Files / Git
 * views of ProjectView). Lightweight inline assistant: pick/create a
 * session, stage the active file + code selections as context, chat. Reuses
 * the chat primitives via `useEditorChatSession`; sessions are shared with
 * the full Chat tab.
 */
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { ArrowLeft, ChevronRight, FilePlus2, FileText, Loader2, Plus } from 'lucide-react';
import { Button } from '../../../components/ui/button.js';
import { TooltipProvider } from '../../../components/ui/tooltip.js';
import { useWorkspaceStore } from '../../../state/workspace.js';
import { editorChatContextActions, useEditorChatContext } from '../../../state/editor-chat-context.js';
import { MessageList } from '../../chat/messages/MessageList.js';
import { Composer } from '../../chat/composer/Composer.js';
import { QueuedMessages } from '../../chat/composer/QueuedMessages.js';
import { SelectionChips } from './SelectionChips.js';
import { SessionPickerDropdown } from './SessionPickerDropdown.js';
import { useEditorChatSession } from './useEditorChatSession.js';

interface Props {
  projectId: number;
  projectName: string;
  onClose: () => void;
}

export function EditorChatRail({ projectId, projectName, onClose }: Props) {
  const { t } = useTranslation('workspace');
  const s = useEditorChatSession(projectId);
  const { fileRefs } = useEditorChatContext(projectId);
  const removeFileRef = (p: string) => editorChatContextActions().removeFileRef(projectId, p);

  const activeFilePath = useWorkspaceStore((st) => st.activeFilePath);
  const openFiles = useWorkspaceStore((st) => st.openFiles);
  const active = openFiles.find(
    (f) => f.path === activeFilePath && f.kind !== 'git-log' && f.kind !== 'git-stash' && f.kind !== 'diff',
  );
  const addablePath = active ? active.path : null;
  const addableName = addablePath ? addablePath.split('/').pop() ?? addablePath : null;
  const alreadyAdded = addablePath != null && fileRefs.includes(addablePath);

  if (s.selectedId == null) {
    return (
      <div className="h-full flex flex-col bg-card/20 min-h-0">
        <RailHeader
          title={t('chat.title')}
          onClose={onClose}
          action={
            <Button
              variant="ghost"
              size="icon"
              className="h-5 w-5 text-muted-foreground hover:text-foreground"
              onClick={() => void s.createSession()}
              disabled={s.creating}
              aria-label={t('chat.new')}
              title={t('chat.new')}
            >
              {s.creating ? <Loader2 className="h-3 w-3 animate-spin" /> : <Plus className="h-3 w-3" />}
            </Button>
          }
        />
        <div className="flex-1 min-h-0">
          <SessionPickerDropdown projectName={projectName} sessions={s.sessions} onPick={s.setSelectedId} />
        </div>
      </div>
    );
  }

  return (
    <TooltipProvider delayDuration={300}>
      <div className="h-full flex flex-col bg-card min-h-0">
        <RailHeader
          title={s.sessionData?.session.title ?? t('chat.title')}
          onBack={() => s.setSelectedId(null)}
          onClose={onClose}
        />
        {/* Active-file affordance — detect + one-click sticky add. */}
        <div className="shrink-0 px-3 py-1.5 border-b flex items-center gap-2 text-[11px] min-w-0">
          <FileText className="h-3 w-3 text-muted-foreground shrink-0" />
          {addablePath ? (
            <>
              <span className="truncate flex-1 text-muted-foreground" title={addablePath}>
                {addableName}
              </span>
              <button
                type="button"
                onClick={() => addablePath && editorChatContextActions().addFileRef(projectId, addablePath)}
                disabled={alreadyAdded}
                className="shrink-0 inline-flex items-center gap-1 h-5 px-1.5 rounded border border-info/30 bg-info/10 text-info hover:bg-info/20 disabled:opacity-50 disabled:cursor-default"
              >
                <FilePlus2 className="h-3 w-3" />
                {t('editorChat.addActiveFile')}
              </button>
            </>
          ) : (
            <span className="text-muted-foreground/60">{t('editorChat.noFileOpen')}</span>
          )}
        </div>
        <div className="flex-1 min-h-0 overflow-hidden flex flex-col">
          <MessageList
            sessionData={s.sessionData}
            currentTurn={s.currentTurn}
            streaming={s.streaming}
            doneReason={s.doneReason}
            error={s.error}
            liveTurnDuplicatedInHistory={s.liveTurnDuplicatedInHistory}
            fallbackProviderId={s.provider}
            tasksState={s.tasksState}
            handlers={s.handlers}
            onLoadEarlier={s.loadEarlierMessages}
          />
        </div>
        <SelectionChips projectId={projectId} />
        <Composer
          compact
          filePicks={fileRefs}
          onRemovePick={removeFileRef}
          onClearPicks={() => editorChatContextActions().clearFileRefs(projectId)}
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
  action,
}: {
  title: string;
  onBack?: () => void;
  onClose: () => void;
  action?: ReactNode;
}) {
  const { t } = useTranslation('workspace');
  return (
    <header className="h-7 shrink-0 border-b bg-card/40 flex items-center px-1.5 gap-1">
      {onBack && (
        <Button
          variant="ghost"
          size="icon"
          className="h-5 w-5 text-muted-foreground hover:text-foreground"
          onClick={onBack}
          aria-label={t('chat.backToSessions')}
        >
          <ArrowLeft className="h-3 w-3" />
        </Button>
      )}
      <span className="text-[10px] font-semibold text-muted-foreground uppercase tracking-[0.08em] flex-1 truncate">
        {title}
      </span>
      {action}
      <Button
        variant="ghost"
        size="icon"
        className="h-5 w-5 text-muted-foreground hover:text-foreground"
        onClick={onClose}
        aria-label={t('chat.closePanel')}
      >
        <ChevronRight className="h-3 w-3" />
      </Button>
    </header>
  );
}
