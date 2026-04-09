import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useAgentStream } from '../../hooks/useAgentStream.js';
import { apiDelete, apiPatch, apiPost, useApi } from '../../hooks/useApi.js';
import { Button } from '../../components/ui/button.js';
import { useConfirm } from '../../components/ui/dialog-provider.js';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../../components/ui/dialog.js';
import { Input } from '../../components/ui/input.js';
import { TooltipProvider } from '../../components/ui/tooltip.js';
import { ChatHeader } from './ChatHeader.js';
import { Composer, type ComposerHandle } from './composer/Composer.js';
import { PROVIDERS } from './constants.js';
import { EmptyChatState } from './EmptyChatState.js';
import { MessageList } from './messages/MessageList.js';
import { SessionDetailsModal } from './SessionDetailsModal.js';
import { TodosSidebar } from './TodosSidebar.js';
import { SessionSidebar, type SessionView } from './SessionSidebar.js';
import { ToolConfigDialog } from './ToolConfigDialog.js';
import { SkillConfigDialog } from './SkillConfigDialog.js';
import type {
  AgentChatProps,
  CoderSession,
  CoderSessionGroup,
  MessagePage,
  PromptHandlers,
  SessionData,
} from './types.js';
import { useAgentChatState } from './useAgentChatState.js';
import type { AgentAttachment } from '../../hooks/useAgentStream.js';

export default function AgentChat({ projectId, projectName, initialSessionId }: AgentChatProps) {
  const confirm = useConfirm();
  const [view, setView] = useState<SessionView>('active');
  const { data: sessions, refetch: refetchSessions } = useApi<CoderSession[]>(
    `/coder/sessions?project_id=${projectId}&archived=${view === 'archived' ? '1' : '0'}`,
  );
  const { data: groups, refetch: refetchGroups } = useApi<CoderSessionGroup[]>(
    `/coder/groups?project_id=${projectId}`,
  );
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [provider, setProvider] = useState('zai');
  const [model, setModel] = useState('');
  const [agent, setAgent] = useState<'explore' | 'plan' | 'build' | 'admin'>('explore');
  const [maxTurns, setMaxTurns] = useState<number | null>(null);
  const composerRef = useRef<ComposerHandle>(null);
  const [newSessionOpen, setNewSessionOpen] = useState(false);
  const [newSessionTitle, setNewSessionTitle] = useState('');
  const [newGroupOpen, setNewGroupOpen] = useState(false);
  const [newGroupName, setNewGroupName] = useState('');
  const [renameGroupTarget, setRenameGroupTarget] = useState<CoderSessionGroup | null>(null);
  const [renameGroupName, setRenameGroupName] = useState('');
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [toolConfigOpen, setToolConfigOpen] = useState(false);
  const [skillConfigOpen, setSkillConfigOpen] = useState(false);
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);

  const sessionUrl = selectedId ? `/coder/sessions/${selectedId}?tail=60` : '';
  const { data: sessionData, refetch: refetchSession, update: updateSessionData } = useApi<SessionData>(sessionUrl);

  const stream = useAgentStream(selectedId);
  const {
    streaming,
    currentTurn,
    doneReason,
    error,
    lastUsage,
    runDelta,
    todos,
    sendMessage,
    reattach,
    abort,
    clearCurrentTurn,
    answerQuestion,
    respondToPlan,
    respondToTasks,
    switchProvider,
  } = stream;

  const { providerOptions, currentProviderModels, tasksState, stats, liveTurnDuplicatedInHistory } =
    useAgentChatState({
      selectedId,
      doneReason,
      sessionData: sessionData ?? null,
      currentTurn,
      provider,
      model,
      setProvider,
      setModel,
    });

  // Honor initialSessionId on mount and whenever it changes (e.g. the user
  // clicks a different recent-session entry while the same project is open).
  useEffect(() => {
    if (initialSessionId && initialSessionId !== selectedId) {
      setSelectedId(initialSessionId);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialSessionId]);

  // Auto-reattach: when a session is selected, probe for an in-flight run on
  // the server. If one exists, open the /attach SSE so the dashboard resumes
  // the live stream the user was seeing before they closed the tab.
  useEffect(() => {
    if (!selectedId || streaming) return;
    let cancelled = false;
    fetch(`/api/coder/sessions/${selectedId}/status`)
      .then((r) => (r.ok ? r.json() : { active: false }))
      .then((s: { active: boolean }) => {
        if (cancelled || !s.active) return;
        void reattach(selectedId, () => refetchSession());
      })
      .catch(() => {
        /* ignore */
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId]);

  useEffect(() => {
    if (!doneReason || !selectedId) return;
    let cancelled = false;
    (async () => {
      await Promise.resolve(refetchSession());
      await Promise.resolve(refetchSessions());
      if (!cancelled) {
        clearCurrentTurn();
        window.dispatchEvent(new CustomEvent('coder:sessions-changed'));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [doneReason, selectedId, refetchSession, refetchSessions, clearCurrentTurn]);

  const persistedMessageCount = sessionData?.messages.length ?? 0;
  useEffect(() => {
    if ((!streaming && currentTurn && persistedMessageCount > 0) || liveTurnDuplicatedInHistory) {
      clearCurrentTurn();
    }
  }, [persistedMessageCount, streaming, currentTurn, clearCurrentTurn, liveTurnDuplicatedInHistory]);

  const handleNewSession = () => {
    setNewSessionTitle('');
    setNewSessionOpen(true);
  };

  const confirmNewSession = async () => {
    const title = newSessionTitle.trim() || 'New session';
    setNewSessionOpen(false);
    const created = await apiPost<CoderSession>('/coder/sessions', {
      project_id: projectId,
      title: title.slice(0, 80),
      provider,
      model: model || PROVIDERS.find((p) => p.id === provider)?.defaultModel,
    });
    refetchSessions();
    setSelectedId(created.id);
    window.dispatchEvent(new CustomEvent('coder:sessions-changed'));
  };

  const handleSend = useCallback(async (text: string, atts: AgentAttachment[]) => {
    if (!text.trim() || !selectedId) return;
    // Single refetch path: onMessageComplete (from the stream) + the
    // doneReason effect. Calling refetchSession() again here races and
    // double-fetches on every turn.
    await sendMessage(text, () => refetchSession(), { attachments: atts, agent, maxTurns });
  }, [selectedId, sendMessage, refetchSession, agent, maxTurns]);


  /**
   * Load earlier messages from the backend and prepend them to sessionData.
   * Called by MessageList when the user clicks "Load earlier".
   * Returns the number of message rows fetched (0 = nothing more to load).
   */
  const loadEarlierMessages = useCallback(async (beforeId: number, limit = 40): Promise<number> => {
    if (!selectedId) return 0;
    try {
      const res = await fetch(`/api/coder/sessions/${selectedId}/messages?before_id=${beforeId}&limit=${limit}`);
      if (!res.ok) return 0;
      const page = (await res.json()) as MessagePage;
      if (!page.message_rows.length) return 0;
      updateSessionData((prev) => ({
        ...prev,
        messages: [...page.messages, ...prev.messages],
        message_rows: [...page.message_rows, ...prev.message_rows],
      }));
      return page.message_rows.length;
    } catch {
      return 0;
    }
  }, [selectedId, updateSessionData]);

  const handleSwitchProvider = async (newProvider: string, newModel: string) => {
    setProvider(newProvider);
    setModel(newModel);
    if (selectedId && (streaming || sessionData)) {
      await switchProvider(newProvider, newModel || undefined);
      refetchSession();
      refetchSessions();
    }
  };

  const handleDelete = async (id: number) => {
    const ok = await confirm({
      title: 'Delete this session?',
      description: 'All messages, tool calls and stats persisted for this session will be removed.',
      variant: 'destructive',
      confirmLabel: 'Delete',
    });
    if (!ok) return;
    await apiDelete(`/coder/sessions/${id}`);
    if (selectedId === id) setSelectedId(null);
    refetchSessions();
  };

  const handleBatchDelete = async (ids: number[]) => {
    if (ids.length === 0) return;
    const ok = await confirm({
      title: `Delete ${ids.length} session${ids.length === 1 ? '' : 's'}?`,
      description: 'All messages and tool calls for the selected sessions will be permanently removed.',
      variant: 'destructive',
      confirmLabel: 'Delete',
    });
    if (!ok) return;
    await apiPost('/coder/sessions/batch-delete', { ids });
    if (selectedId != null && ids.includes(selectedId)) setSelectedId(null);
    refetchSessions();
  };

  const handleArchive = async (id: number, archived: boolean) => {
    await apiPatch(`/coder/sessions/${id}/archive`, { archived });
    // Session leaves the current view — drop selection.
    if (selectedId === id) setSelectedId(null);
    refetchSessions();
    window.dispatchEvent(new CustomEvent('coder:sessions-changed'));
  };

  const handleFavorite = async (id: number, favorite: boolean) => {
    await apiPatch(`/coder/sessions/${id}/favorite`, { favorite });
    refetchSessions();
    window.dispatchEvent(new CustomEvent('coder:sessions-changed'));
  };

  const handleFork = async (messageId: number) => {
    if (!selectedId) return;
    const res = await apiPost<{ session: CoderSession; seed_text: string }>(
      `/coder/sessions/${selectedId}/fork`,
      { before_message_id: messageId },
    );
    await refetchSessions();
    setSelectedId(res.session.id);
    composerRef.current?.setInput(res.seed_text);
    window.dispatchEvent(new CustomEvent('coder:sessions-changed'));
  };

  const handleBatchArchive = async (ids: number[], archived: boolean) => {
    await Promise.all(ids.map((id) => apiPatch(`/coder/sessions/${id}/archive`, { archived })));
    if (selectedId != null && ids.includes(selectedId)) setSelectedId(null);
    refetchSessions();
  };

  const handleMoveToGroup = async (id: number, groupId: number | null) => {
    await apiPatch(`/coder/sessions/${id}/group`, { group_id: groupId });
    refetchSessions();
  };

  const handleBatchMoveToGroup = async (ids: number[], groupId: number | null) => {
    await Promise.all(
      ids.map((id) => apiPatch(`/coder/sessions/${id}/group`, { group_id: groupId })),
    );
    refetchSessions();
  };

  const handleCreateGroup = async () => {
    setNewGroupName('');
    setNewGroupOpen(true);
  };

  const confirmCreateGroup = async () => {
    const name = newGroupName.trim();
    if (!name) return;
    await apiPost<CoderSessionGroup>('/coder/groups', {
      project_id: projectId,
      name,
    });
    setNewGroupOpen(false);
    setNewGroupName('');
    refetchGroups();
  };

  const handleRenameGroup = async (group: CoderSessionGroup) => {
    setRenameGroupTarget(group);
    setRenameGroupName(group.name);
  };

  const confirmRenameGroup = async () => {
    if (!renameGroupTarget) return;
    const name = renameGroupName.trim();
    if (!name || name === renameGroupTarget.name) {
      setRenameGroupTarget(null);
      return;
    }
    await apiPatch(`/coder/groups/${renameGroupTarget.id}`, { name });
    setRenameGroupTarget(null);
    refetchGroups();
  };

  const handleDeleteGroup = async (group: CoderSessionGroup) => {
    const ok = await confirm({
      title: `Delete group "${group.name}"?`,
      description: 'Sessions in this group will remain but become ungrouped.',
      variant: 'destructive',
      confirmLabel: 'Delete',
    });
    if (!ok) return;
    await apiDelete(`/coder/groups/${group.id}`);
    refetchGroups();
    refetchSessions();
  };

  // Stable handlers reference so the memoized <PersistedMessages /> inside
  // MessageList doesn't re-render on every parent render. Deps are the three
  // useCallback-stable functions from useAgentStream.
  const handlers: PromptHandlers = useMemo(
    () => ({
      onAnswer: (answer) => answerQuestion(answer),
      onPlanResponse: (approved, feedback) => respondToPlan(approved, feedback),
      onTasksResponse: (verdict) => respondToTasks(verdict),
      onFork: handleFork,
    }),
    // handleFork depends on selectedId — re-create when session changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [answerQuestion, respondToPlan, respondToTasks, selectedId],
  );

  return (
    <TooltipProvider delayDuration={300}>
      <Dialog open={newSessionOpen} onOpenChange={setNewSessionOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>New Session</DialogTitle>
            <DialogDescription>Enter a title for the new chat session.</DialogDescription>
          </DialogHeader>
          <Input
            autoFocus
            placeholder="Session title"
            value={newSessionTitle}
            onChange={(e) => setNewSessionTitle(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') confirmNewSession();
            }}
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setNewSessionOpen(false)}>
              Cancel
            </Button>
            <Button onClick={confirmNewSession}>Create</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog open={newGroupOpen} onOpenChange={setNewGroupOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>New Group</DialogTitle>
            <DialogDescription>Create a group to organize your chat sessions.</DialogDescription>
          </DialogHeader>
          <Input
            autoFocus
            placeholder="Group name"
            value={newGroupName}
            onChange={(e) => setNewGroupName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') confirmCreateGroup();
            }}
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setNewGroupOpen(false)}>
              Cancel
            </Button>
            <Button onClick={confirmCreateGroup} disabled={!newGroupName.trim()}>
              Create
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog
        open={!!renameGroupTarget}
        onOpenChange={(open) => { if (!open) setRenameGroupTarget(null); }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Rename Group</DialogTitle>
            <DialogDescription>Choose a new name for this group.</DialogDescription>
          </DialogHeader>
          <Input
            autoFocus
            placeholder="Group name"
            value={renameGroupName}
            onChange={(e) => setRenameGroupName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') confirmRenameGroup();
            }}
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setRenameGroupTarget(null)}>
              Cancel
            </Button>
            <Button
              onClick={confirmRenameGroup}
              disabled={!renameGroupName.trim() || renameGroupName.trim() === renameGroupTarget?.name}
            >
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <SessionDetailsModal
        open={detailsOpen}
        onOpenChange={setDetailsOpen}
        sessionId={selectedId}
        session={sessionData?.session ?? null}
        stats={stats}
      />
      <ToolConfigDialog
        sessionId={selectedId}
        open={toolConfigOpen}
        onOpenChange={setToolConfigOpen}
      />
      <SkillConfigDialog
        sessionId={selectedId}
        open={skillConfigOpen}
        onOpenChange={setSkillConfigOpen}
      />
      <div className="grid grid-cols-1 lg:grid-cols-[300px_1fr] gap-4 h-[calc(100dvh-180px)] sm:h-[calc(100dvh-220px)] min-h-[520px] lg:min-h-[600px]">
        <SessionSidebar
          sessions={sessions ?? null}
          groups={groups ?? null}
          view={view}
          onViewChange={(v) => {
            setView(v);
            setSelectedId(null);
          }}
          selectedId={selectedId}
          onSelect={(id) => {
            setSelectedId(id);
            setMobileSidebarOpen(false);
          }}
          mobileOpen={mobileSidebarOpen}
          onMobileClose={() => setMobileSidebarOpen(false)}
          onNew={handleNewSession}
          onDelete={handleDelete}
          onBatchDelete={handleBatchDelete}
          onArchive={handleArchive}
          onFavorite={handleFavorite}
          onBatchArchive={handleBatchArchive}
          onMoveToGroup={handleMoveToGroup}
          onBatchMoveToGroup={handleBatchMoveToGroup}
          onCreateGroup={handleCreateGroup}
          onRenameGroup={handleRenameGroup}
          onDeleteGroup={handleDeleteGroup}
          projectName={projectName}
          provider={provider}
          setProvider={(v) => {
            setProvider(v);
            setModel('');
          }}
          model={model}
          setModel={setModel}
          providerOptions={providerOptions}
          currentProviderModels={currentProviderModels}
        />

        <main className="flex flex-col rounded-xl border bg-card overflow-hidden min-h-0">
          {!selectedId ? (
            <EmptyChatState
              onNew={handleNewSession}
              projectName={projectName}
              onOpenSidebar={() => setMobileSidebarOpen(true)}
            />
          ) : (
            <>
              {sessionData?.session && (
                <ChatHeader
                  session={sessionData.session}
                  streaming={streaming}
                  runDelta={runDelta}
                  lastUsage={lastUsage}
                  stats={stats}
                  onOpenDetails={() => setDetailsOpen(true)}
                  onOpenSidebar={() => setMobileSidebarOpen(true)}
                  onOpenToolConfig={() => setToolConfigOpen(true)}
                  onOpenSkillConfig={() => setSkillConfigOpen(true)}
                />
              )}
              <div className="flex flex-1 min-h-0 overflow-hidden">
                <div className="flex-1 min-w-0 flex flex-col">
                  <MessageList
                    sessionData={sessionData ?? null}
                    currentTurn={currentTurn}
                    streaming={streaming}
                    doneReason={doneReason}
                    error={error}
                    liveTurnDuplicatedInHistory={liveTurnDuplicatedInHistory}
                    fallbackProviderId={provider}
                    tasksState={tasksState}
                    handlers={handlers}
                    onLoadEarlier={loadEarlierMessages}
                  />
                </div>
                <TodosSidebar todos={todos} />
              </div>
              <Composer
                ref={composerRef}
                agent={agent}
                setAgent={setAgent}
                provider={provider}
                model={model}
                setModel={setModel}
                onSwitchProvider={handleSwitchProvider}
                onSend={handleSend}
                onAbort={abort}
                streaming={streaming}
                providerOptions={providerOptions}
                currentProviderModels={currentProviderModels}
                maxTurns={maxTurns}
                setMaxTurns={setMaxTurns}
                sessionId={selectedId}
                onInvokeSkill={async (skillId, input) => {
                  if (!selectedId) return;
                  try {
                    const r = await fetch(`/api/coder/sessions/${selectedId}/invoke-skill`, {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({ skill_id: skillId, input }),
                    });
                    const data = (await r.json()) as { message: string; skill_name: string };
                    handleSend(data.message, []);
                  } catch {
                    // Fallback: send as regular message
                    handleSend(`/${skillId} ${input}`.trim(), []);
                  }
                }}
              />
            </>
          )}
        </main>
      </div>
    </TooltipProvider>
  );
}
