/**
 * Copilot-style chat rail docked beside the Monaco editor (Files / Git
 * views of ProjectView). Lightweight inline assistant: pick/create a
 * session, stage the active file + code selections as context, chat. Reuses
 * the chat primitives via `useEditorChatSession`; sessions are shared with
 * the full Chat tab.
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { ArrowLeft, ChevronRight, FilePlus2, FileText, FolderPlus, Loader2, Plus } from 'lucide-react';
import { Button } from '../../../components/ui/button.js';
import { TooltipProvider } from '../../../components/ui/tooltip.js';
import { confirm, prompt } from '../../../components/ui/prompt-dialog.js';
import { useWorkspaceStore } from '../../../state/workspace.js';
import { editorChatContextActions, useEditorChatContext } from '../../../state/editor-chat-context.js';
import { MessageList } from '../../chat/messages/MessageList.js';
import { Composer } from '../../chat/composer/Composer.js';
import { QueuedMessages } from '../../chat/composer/QueuedMessages.js';
import {
  firstModelValue,
  SessionLaunchDialog,
  type SessionLaunchConfig,
} from '../../chat/SessionLaunchDialog.js';
import { SelectionChips } from './SelectionChips.js';
import { SessionPickerDropdown } from './SessionPickerDropdown.js';
import { useEditorChatSession } from './useEditorChatSession.js';
import type { AgentPreset } from '@mcp/api-bus';

interface Props {
  projectId: number;
  projectName: string;
  onClose: () => void;
  initialSessionId?: number | null;
  onSelectedSessionChange?: (sessionId: number | null) => void;
  selectionPrefixSessionId?: number;
  includeEditorContext?: boolean;
  initialAgent?: AgentPreset;
  newSessionTitle?: string;
}

export function EditorChatRail({
  projectId,
  projectName,
  onClose,
  initialSessionId,
  onSelectedSessionChange,
  selectionPrefixSessionId,
  includeEditorContext = true,
  initialAgent,
  newSessionTitle,
}: Props) {
  const { t } = useTranslation(['workspace', 'chat', 'common', 'dbClient']);
  const s = useEditorChatSession(projectId, {
    initialSessionId: initialSessionId ?? undefined,
    selectionPrefixSessionId,
    includeEditorContext,
    initialAgent,
    newSessionTitle,
  });
  const { fileRefs } = useEditorChatContext(projectId);
  const removeFileRef = (p: string) => editorChatContextActions().removeFileRef(projectId, p);
  const pendingExternalPrompt = useRef<{ prompt: string; title?: string } | null>(null);
  const [launchRequest, setLaunchRequest] = useState<{
    config: SessionLaunchConfig;
    prompt?: string;
    lockedAgent?: AgentPreset;
    dialogTitle?: string;
    dialogDescription?: string;
  } | null>(null);

  useEffect(() => {
    onSelectedSessionChange?.(s.selectedId);
  }, [onSelectedSessionChange, s.selectedId]);

  const buildLaunchConfig = useCallback((title = '', agent?: AgentPreset): SessionLaunchConfig => {
    const models = s.getModelsForProvider(s.provider);
    const availableModelValues = models.map((candidate) => candidate.mode ? `${candidate.id}::${candidate.mode}` : candidate.id);
    const model = availableModelValues.includes(s.model) ? s.model : firstModelValue(models);
    return {
      title,
      agent: agent ?? s.agent,
      provider: s.provider,
      model,
      executionMode: s.executionMode,
      reasoningEffort: s.reasoningEffort,
      thinking: s.thinking,
      maxTurns: s.maxTurns,
      temperature: s.temperature,
    };
  }, [s.agent, s.executionMode, s.getModelsForProvider, s.maxTurns, s.model, s.provider, s.reasoningEffort, s.temperature, s.thinking]);

  useEffect(() => {
    const onExternalPrompt = (event: Event) => {
      const detail = (event as CustomEvent<{ prompt?: string; newSession?: boolean; title?: string; agent?: AgentPreset }>).detail;
      const promptText = detail?.prompt?.trim();
      if (!promptText) return;
      if (s.selectedId != null && !detail.newSession) {
        void s.handleSend(promptText, []);
        return;
      }
      const isDatabaseSpecialist = detail.agent === 'app_db';
      setLaunchRequest({
        config: buildLaunchConfig(detail.title ?? '', detail.agent),
        prompt: promptText,
        lockedAgent: detail.agent,
        dialogTitle: isDatabaseSpecialist ? t('dbClient:specialist.configureTitle') : undefined,
        dialogDescription: isDatabaseSpecialist ? t('dbClient:specialist.configureDescription') : undefined,
      });
    };
    window.addEventListener('mcp:editor-chat-prompt', onExternalPrompt);
    return () => window.removeEventListener('mcp:editor-chat-prompt', onExternalPrompt);
  }, [buildLaunchConfig, s.handleSend, s.selectedId, t]);

  useEffect(() => {
    if (s.selectedId == null || !pendingExternalPrompt.current) return;
    const { prompt: promptText } = pendingExternalPrompt.current;
    pendingExternalPrompt.current = null;
    void s.handleSend(promptText, []);
  }, [s.handleSend, s.selectedId]);

  const createConfiguredSession = async (config: SessionLaunchConfig) => {
    if (!launchRequest) return;
    if (launchRequest.prompt) {
      pendingExternalPrompt.current = { prompt: launchRequest.prompt, title: config.title || undefined };
    }
    try {
      const id = await s.createSession(config);
      if (id == null) pendingExternalPrompt.current = null;
      setLaunchRequest(null);
    } catch {
      pendingExternalPrompt.current = null;
    }
  };

  const launchDialog = launchRequest ? (
    <SessionLaunchDialog
      open
      onOpenChange={(open) => {
        if (!open) {
          pendingExternalPrompt.current = null;
          setLaunchRequest(null);
        }
      }}
      value={launchRequest.config}
      onChange={(config) => setLaunchRequest((current) => current ? { ...current, config } : current)}
      onCreate={createConfiguredSession}
      providerOptions={s.providerOptions}
      getModelsForProvider={s.getModelsForProvider}
      creating={s.creating}
      lockedAgent={launchRequest.lockedAgent}
      title={launchRequest.dialogTitle}
      description={launchRequest.dialogDescription}
    />
  ) : null;

  // Select the stable path instead of the entire openFiles array. The Monaco
  // buffer mirrors content into that array on every key; the rail does not need
  // the text and must not rerender its conversation tree while typing.
  const addablePath = useWorkspaceStore((st) => includeEditorContext && st.activeProjectId === projectId
    ? st.openFiles.find(
    (file) => file.projectId === projectId
      && file.path === st.activeFilePath
      && file.kind !== 'git-log'
      && file.kind !== 'git-stash'
      && file.kind !== 'diff'
      && file.kind !== 'database',
  )?.path ?? null
    : null);
  const addableName = addablePath ? addablePath.split('/').pop() ?? addablePath : null;
  const alreadyAdded = addablePath != null && fileRefs.includes(addablePath);

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
      <>
        {launchDialog}
        <div className="h-full flex flex-col bg-[var(--workbench-surface)] min-h-0">
        <RailHeader
          title={t('chat.title')}
          onClose={onClose}
          action={
            <>
              <Button
                variant="ghost"
                size="icon"
                className="h-5 w-5 text-muted-foreground hover:text-foreground"
                onClick={() => void createGroup()}
                aria-label={t('chat:sidebar.newGroup')}
                title={t('chat:sidebar.newGroup')}
              >
                <FolderPlus className="h-3 w-3" />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                className="h-5 w-5 text-muted-foreground hover:text-foreground"
                onClick={() => {
                  void s.createSession({ useLastModel: true }).catch((error) => {
                    console.warn('[editor-chat] new session creation failed:', error);
                  });
                }}
                disabled={s.creating}
                aria-label={t('chat.new')}
                title={t('chat.new')}
              >
                {s.creating ? <Loader2 className="h-3 w-3 animate-spin" /> : <Plus className="h-3 w-3" />}
              </Button>
            </>
          }
        />
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
      </>
    );
  }

  return (
    <TooltipProvider delayDuration={300}>
      <>
        {launchDialog}
        <div className="h-full flex flex-col bg-[var(--workbench-surface)] min-h-0">
        <RailHeader
          title={s.sessionData?.session.title ?? t('chat.title')}
          onBack={() => s.setSelectedId(null)}
          onClose={onClose}
        />
        {/* Active-file affordance — only meaningful inside the code editor. */}
        {includeEditorContext && <div className="shrink-0 px-3 py-1.5 border-b flex items-center gap-2 text-[11px] min-w-0">
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
        </div>}
        <div className="flex-1 min-h-0 overflow-hidden flex flex-col">
          <MessageList
            sessionData={s.sessionData}
            currentTurn={s.currentTurn}
            streaming={s.streaming}
            doneReason={s.doneReason}
            error={s.error}
            liveReconciliation={s.liveReconciliation}
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
        {includeEditorContext && <SelectionChips projectId={projectId} />}
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
          ultraControlsThinking={s.ultraControlsThinking}
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
          executionMode={s.executionMode}
          setExecutionMode={s.setExecutionMode}
          executionModePending={s.executionModePending}
          executionModeLocked={s.executionModeLocked}
          sendBlocked={s.executionModePending}
          planDepth={s.planDepth}
          setPlanDepth={s.setPlanDepth}
          getModelsForProvider={s.getModelsForProvider}
          queueable={s.selectedId != null}
          onQueue={s.handleQueue}
          queuedStrip={<QueuedMessages items={s.queue.items} onPromote={s.queue.promote} onRemove={s.queue.remove} />}
        />
        </div>
      </>
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
    <header className="h-8 shrink-0 border-b border-[var(--workbench-border)] bg-[var(--workbench-raised)] flex items-center px-1.5 gap-1">
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
