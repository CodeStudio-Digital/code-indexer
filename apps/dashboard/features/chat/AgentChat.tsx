import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useAgentStream } from '../../hooks/useAgentStream.js';
import { usePipelineStream } from '../../hooks/usePipelineStream.js';
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
import { SessionStateSidebar } from './SessionStateSidebar.js';
import { Composer, type ComposerHandle } from './composer/Composer.js';
import { providerSupportsThinking } from './composer/provider-caps.js';
import { PROVIDERS } from './constants.js';
import { EmptyChatState } from './EmptyChatState.js';
import { MessageList } from './messages/MessageList.js';
import { SessionDetailsModal } from './SessionDetailsModal.js';
import { SessionMetricsModal } from './SessionMetricsModal.js';
import { SessionSidebar, type SessionView } from './SessionSidebar.js';
import { ToolConfigDialog } from './ToolConfigDialog.js';
import { SkillConfigDialog } from './SkillConfigDialog.js';
import { SnapshotsPanel } from '../snapshots/SnapshotsPanel.js';
import { fetchSnapshotList } from '../snapshots/api.js';
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
  const { t } = useTranslation(['chat', 'common']);
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
  const [fallbackProvider, setFallbackProvider] = useState<string | null>(null);
  const [fallbackModel, setFallbackModel] = useState<string | null>(null);
  const [sessionTemperature, setSessionTemperature] = useState<number | null>(null);
  const [unrestrictedOutput, setUnrestrictedOutput] = useState<boolean>(false);
  const composerRef = useRef<ComposerHandle>(null);
  const pendingAutoTitle = useRef<Set<number>>(new Set());
  const [newSessionOpen, setNewSessionOpen] = useState(false);
  const [newSessionTitle, setNewSessionTitle] = useState('');
  const [newGroupOpen, setNewGroupOpen] = useState(false);
  const [newGroupName, setNewGroupName] = useState('');
  const [renameGroupTarget, setRenameGroupTarget] = useState<CoderSessionGroup | null>(null);
  const [renameGroupName, setRenameGroupName] = useState('');
  const [renameSessionTarget, setRenameSessionTarget] = useState<{ id: number; title: string } | null>(null);
  const [renameSessionTitle, setRenameSessionTitle] = useState('');
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [toolConfigOpen, setToolConfigOpen] = useState(false);
  const [skillConfigOpen, setSkillConfigOpen] = useState(false);
  const [metricsOpen, setMetricsOpen] = useState(false);
  const [snapshotsOpen, setSnapshotsOpen] = useState(false);
  const [snapshotPending, setSnapshotPending] = useState(0);
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
  const [thinking, setThinking] = useState(false);
  /** PR-4: when set, the Composer's send button flips to "Run pipeline". */
  const [selectedPipelineId, setSelectedPipelineId] = useState<number | null>(null);

  const sessionUrl = selectedId ? `/coder/sessions/${selectedId}?tail=120` : '';
  const { data: sessionData, refetch: refetchSession, update: updateSessionData } = useApi<SessionData>(sessionUrl);

  const stream = useAgentStream(selectedId);
  const { pipelineRuntime } = usePipelineStream(selectedId);
  const {
    streaming,
    currentTurn,
    doneReason,
    error,
    lastUsage,
    runDelta,
    todos,
    contextStatus,
    indexStatus,
    sidebarRefreshTick,
    snapshotTick,
    sendMessage,
    reattach,
    abort,
    clearCurrentTurn,
    answerQuestion,
    respondToPlan,
    respondToTasks,
    switchProvider,
  } = stream;

  const { providerOptions, currentProviderModels, getModelsForProvider, tasksState, stats, liveTurnDuplicatedInHistory } =
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

  // Pending-snapshot count — refetched on selection change and whenever the
  // SSE stream pings `session_snapshot_changed`. Used as a badge on the
  // Snapshots button in the chat header.
  useEffect(() => {
    if (!selectedId) {
      setSnapshotPending(0);
      return;
    }
    let cancelled = false;
    fetchSnapshotList('coder', selectedId)
      .then((r) => {
        if (cancelled) return;
        const pending = r.files
          .filter((f) => f.status === 'active')
          .reduce((acc, f) => acc + (f.pendingHunks || (f.hunkCount === 0 ? 1 : 0)), 0);
        setSnapshotPending(pending);
      })
      .catch(() => {
        if (!cancelled) setSnapshotPending(0);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedId, snapshotTick]);

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

  // Bump the SessionStateSidebar refresh key whenever a turn ends — that's
  // the cheapest place to catch goal / tasks state mutations without
  // wiring a per-tool listener. Network cost is negligible (1 fetch / turn
  // boundary) and the user gets fresh banner state right after each model
  // response. Also bumps on session change.
  const [stateRefreshKey, setStateRefreshKey] = useState(0);
  const wasStreamingRef = useRef(false);
  useEffect(() => {
    if (wasStreamingRef.current && !streaming) {
      setStateRefreshKey((k) => k + 1);
    }
    wasStreamingRef.current = streaming;
  }, [streaming]);

  // Goal/tasks state lives in DB and the sidebar reads it via a separate
  // /state-summary fetch. End-of-turn refresh isn't enough — a long turn that
  // creates a goal and runs many tasks would leave the sidebar stale until it
  // ends. So also bump the key whenever a goal/tasks-related tool finishes
  // mid-stream. We track completion count and bump when it grows.
  const goalToolDoneCountRef = useRef(0);
  useEffect(() => {
    if (!currentTurn) {
      goalToolDoneCountRef.current = 0;
      return;
    }
    const goalToolNames = new Set([
      'create_goal',
      'update_goal',
      'get_goal',
      'submit_tasks',
      'execute_task',
      'task_complete',
      'approve_subordinate_tasks',
      'submit_tasks_to_master',
    ]);
    let count = 0;
    for (const b of currentTurn.blocks) {
      if (b.type !== 'tool') continue;
      if (b.call.status !== 'done') continue;
      if (goalToolNames.has(b.call.name)) count += 1;
    }
    if (count > goalToolDoneCountRef.current) {
      goalToolDoneCountRef.current = count;
      setStateRefreshKey((k) => k + 1);
    }
  }, [currentTurn]);

  // File picks: paths selected in ProjectFilesSection that get injected as
  // `<file_refs>` into the next outgoing message. Lives here (not inside the
  // sidebar) so it survives section collapse / scroll.
  const [filePicks, setFilePicks] = useState<string[]>([]);
  const togglePick = useCallback((path: string) => {
    setFilePicks((prev) => (prev.includes(path) ? prev.filter((p) => p !== path) : [...prev, path]));
  }, []);
  const setManyPicks = useCallback((paths: string[], select: boolean) => {
    setFilePicks((prev) => {
      if (select) {
        const set = new Set(prev);
        for (const p of paths) set.add(p);
        return Array.from(set);
      }
      const drop = new Set(paths);
      return prev.filter((p) => !drop.has(p));
    });
  }, []);
  const clearPicks = useCallback(() => setFilePicks([]), []);

  // Skill picks: skill ids selected in SkillsSection. The server expands them
  // into an `<active_skills>` block prepended to the user message so the agent
  // does not need to discover or load the skill content via tool calls first.
  const [skillPicks, setSkillPicks] = useState<string[]>([]);
  const toggleSkillPick = useCallback((id: string) => {
    setSkillPicks((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  }, []);
  const clearSkillPicks = useCallback(() => setSkillPicks([]), []);

  // Reset picks when switching sessions.
  useEffect(() => {
    setFilePicks([]);
    setSkillPicks([]);
  }, [selectedId]);

  const createSession = async (title?: string) => {
    const created = await apiPost<CoderSession>('/coder/sessions', {
      project_id: projectId,
      title: (title ?? 'Nova sessão').slice(0, 80),
      provider,
      model: model || PROVIDERS.find((p) => p.id === provider)?.defaultModel,
    });
    if (!title) pendingAutoTitle.current.add(created.id);
    refetchSessions();
    setSelectedId(created.id);
    window.dispatchEvent(new CustomEvent('coder:sessions-changed'));
    return created;
  };

  const handleNewSession = () => {
    void createSession();
  };

  const confirmNewSession = async () => {
    const title = newSessionTitle.trim();
    setNewSessionOpen(false);
    await createSession(title || undefined);
  };

  const handleSend = useCallback(async (text: string, atts: AgentAttachment[], selectedSkillIds?: string[]) => {
    if (!text.trim() || !selectedId) return;
    const shouldAutoTitle = pendingAutoTitle.current.has(selectedId);
    if (shouldAutoTitle) pendingAutoTitle.current.delete(selectedId);
    await sendMessage(text, async () => {
      refetchSession();
      if (shouldAutoTitle) {
        apiPost<{ title: string }>(`/coder/sessions/${selectedId}/generate-title`, {})
          .then(() => {
            refetchSessions();
            window.dispatchEvent(new CustomEvent('coder:sessions-changed'));
          })
          .catch((err) => {
            // Visible diagnostic instead of silent swallow — auto-title
            // failures used to be invisible (no provider configured, OAuth
            // provider, etc.) and the user had no way to tell what went wrong.
            console.warn('[auto-title] generate-title failed:', err);
          });
      }
    }, { attachments: atts, agent, maxTurns, thinking, selectedSkillIds });
  }, [selectedId, sendMessage, refetchSession, refetchSessions, agent, maxTurns, thinking]);

  /**
   * Pipeline-mode send: post to `/pipelines/:pid/start` instead of
   * /messages. Pipeline events arrive over a separate SSE stream — see
   * `usePipelineStream` consumed by the SessionStateSidebar.
   */
  const handleRunPipeline = useCallback(async (pipelineId: number, initialInput: string) => {
    if (!selectedId) return;
    try {
      await apiPost(`/coder/sessions/${selectedId}/pipelines/${pipelineId}/start`, {
        initial_input: initialInput,
      });
    } catch (err) {
      console.warn('[pipeline] start failed:', err);
    }
  }, [selectedId]);


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

  // Fallback: load from session when selected, save when changed
  useEffect(() => {
    if (!selectedId) return;
    fetch(`/api/coder/sessions/${selectedId}/fallback`)
      .then((r) => r.json())
      .then((data: { fallback_provider: string | null; fallback_model: string | null }) => {
        setFallbackProvider(data.fallback_provider);
        setFallbackModel(data.fallback_model);
      })
      .catch(() => {});
  }, [selectedId]);

  // Temperature override: load from the selected session row. The full session
  // payload already includes `temperature_override` since the column flows
  // through `SELECT *` mapping; no extra endpoint needed for read.
  useEffect(() => {
    if (!sessionData?.session) {
      setSessionTemperature(null);
      return;
    }
    const t = (sessionData.session as { temperature_override?: number | null }).temperature_override;
    setSessionTemperature(typeof t === 'number' ? t : null);
  }, [sessionData?.session]);

  // Unrestricted-tool-output toggle (migration 078). Same pattern as the
  // temperature override above — reads from the session row, writes via PATCH.
  useEffect(() => {
    if (!sessionData?.session) {
      setUnrestrictedOutput(false);
      return;
    }
    const v = sessionData.session.unrestricted_tool_output;
    setUnrestrictedOutput(!!v);
  }, [sessionData?.session]);

  const handleTemperatureChange = async (next: number | null) => {
    setSessionTemperature(next);
    if (!selectedId) return;
    try {
      await apiPatch(`/coder/sessions/${selectedId}/temperature`, { temperature: next });
    } catch {
      /* ignore — UI optimistic, server is the source of truth on next refetch */
    }
  };

  const handleUnrestrictedOutputChange = async (next: boolean) => {
    setUnrestrictedOutput(next);
    if (!selectedId) return;
    try {
      await apiPatch(`/coder/sessions/${selectedId}/unrestricted-output`, { enabled: next });
    } catch {
      /* ignore — UI optimistic, server is the source of truth on next refetch */
    }
  };

  const handleFallbackChange = async (fbProvider: string | null, fbModel: string | null) => {
    setFallbackProvider(fbProvider);
    setFallbackModel(fbModel);
    if (selectedId) {
      await fetch(`/api/coder/sessions/${selectedId}/fallback`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider: fbProvider, model: fbModel }),
      });
    }
  };

  const handleDelete = async (id: number) => {
    const ok = await confirm({
      title: t('chat:deleteSession'),
      description: t('chat:deleteSessionDescription'),
      variant: 'destructive',
      confirmLabel: t('common:actions.delete'),
    });
    if (!ok) return;
    await apiDelete(`/coder/sessions/${id}`);
    if (selectedId === id) setSelectedId(null);
    refetchSessions();
  };

  const handleBatchDelete = async (ids: number[]) => {
    if (ids.length === 0) return;
    const ok = await confirm({
      title: t('chat:deleteSessions', { count: ids.length }),
      description: t('chat:deleteSessionsDescription'),
      variant: 'destructive',
      confirmLabel: t('common:actions.delete'),
    });
    if (!ok) return;
    await apiPost('/coder/sessions/batch-delete', { ids });
    if (selectedId != null && ids.includes(selectedId)) setSelectedId(null);
    refetchSessions();
  };

  const handleDeleteAll = async () => {
    const ids = (sessions ?? []).map((s) => s.id);
    if (ids.length === 0) return;
    const ok = await confirm({
      title: t('chat:deleteAllSessions', { count: ids.length }),
      description: t(
        view === 'archived' ? 'chat:deleteAllArchivedDescription' : 'chat:deleteAllActiveDescription',
      ),
      variant: 'destructive',
      confirmLabel: t('common:actions.delete'),
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

  const handleRenameSession = (id: number, currentTitle: string) => {
    setRenameSessionTarget({ id, title: currentTitle });
    setRenameSessionTitle(currentTitle);
  };

  const confirmRenameSession = async () => {
    if (!renameSessionTarget) return;
    const title = renameSessionTitle.trim();
    if (!title || title === renameSessionTarget.title) {
      setRenameSessionTarget(null);
      return;
    }
    await apiPatch(`/coder/sessions/${renameSessionTarget.id}/title`, { title });
    setRenameSessionTarget(null);
    refetchSessions();
    window.dispatchEvent(new CustomEvent('coder:sessions-changed'));
  };

  const handleDuplicate = async (id: number) => {
    const res = await apiPost<{ session: CoderSession }>(`/coder/sessions/${id}/duplicate`, {});
    await refetchSessions();
    setSelectedId(res.session.id);
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
      title: t('chat:deleteGroup', { name: group.name }),
      description: t('chat:deleteGroupDescription'),
      variant: 'destructive',
      confirmLabel: t('common:actions.delete'),
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
      onPlanResponse: async (approved, feedback) => {
        await respondToPlan(approved, feedback);
        // Iteration 2: after an approved plan, the backend may auto-transition
        // the session agent from 'plan' to 'build'. Refetch the session
        // metadata so the AgentPicker reflects the new mode without
        // requiring a manual reload.
        if (approved && selectedId) {
          try {
            const r = await fetch(`/api/coder/sessions/${selectedId}`);
            if (r.ok) {
              const s = (await r.json()) as { agent?: string };
              if (
                s.agent
                && s.agent !== agent
                && (s.agent === 'explore' || s.agent === 'plan' || s.agent === 'build' || s.agent === 'admin')
              ) {
                setAgent(s.agent);
              }
            }
          } catch {
            /* non-fatal: AgentPicker just keeps the stale value */
          }
        }
      },
      onTasksResponse: (verdict) => respondToTasks(verdict),
      onFork: handleFork,
    }),
    // handleFork depends on selectedId — re-create when session changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [answerQuestion, respondToPlan, respondToTasks, selectedId, agent],
  );

  return (
    <TooltipProvider delayDuration={300}>
      <Dialog open={newSessionOpen} onOpenChange={setNewSessionOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t('chat:newSessionTitle')}</DialogTitle>
            <DialogDescription>{t('chat:newSessionDescription')}</DialogDescription>
          </DialogHeader>
          <Input
            autoFocus
            placeholder={t('chat:sessionTitlePlaceholder')}
            value={newSessionTitle}
            onChange={(e) => setNewSessionTitle(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') confirmNewSession();
            }}
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setNewSessionOpen(false)}>
              {t('common:actions.cancel')}
            </Button>
            <Button onClick={confirmNewSession}>{t('common:actions.create')}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog open={newGroupOpen} onOpenChange={setNewGroupOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t('chat:newGroup')}</DialogTitle>
            <DialogDescription>{t('chat:newGroupDescription')}</DialogDescription>
          </DialogHeader>
          <Input
            autoFocus
            placeholder={t('chat:groupNamePlaceholder')}
            value={newGroupName}
            onChange={(e) => setNewGroupName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') confirmCreateGroup();
            }}
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setNewGroupOpen(false)}>
              {t('common:actions.cancel')}
            </Button>
            <Button onClick={confirmCreateGroup} disabled={!newGroupName.trim()}>
              {t('common:actions.create')}
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
            <DialogTitle>{t('chat:renameGroup')}</DialogTitle>
            <DialogDescription>{t('chat:renameGroupDescription')}</DialogDescription>
          </DialogHeader>
          <Input
            autoFocus
            placeholder={t('chat:groupNamePlaceholder')}
            value={renameGroupName}
            onChange={(e) => setRenameGroupName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') confirmRenameGroup();
            }}
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setRenameGroupTarget(null)}>
              {t('common:actions.cancel')}
            </Button>
            <Button
              onClick={confirmRenameGroup}
              disabled={!renameGroupName.trim() || renameGroupName.trim() === renameGroupTarget?.name}
            >
              {t('common:actions.save')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog
        open={!!renameSessionTarget}
        onOpenChange={(open) => { if (!open) setRenameSessionTarget(null); }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t('chat:renameSession')}</DialogTitle>
          </DialogHeader>
          <Input
            autoFocus
            placeholder={t('chat:sessionNamePlaceholder')}
            value={renameSessionTitle}
            onChange={(e) => setRenameSessionTitle(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') confirmRenameSession(); }}
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setRenameSessionTarget(null)}>
              {t('common:actions.cancel')}
            </Button>
            <Button
              onClick={confirmRenameSession}
              disabled={!renameSessionTitle.trim() || renameSessionTitle.trim() === renameSessionTarget?.title}
            >
              {t('common:actions.save')}
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
      <SessionMetricsModal
        open={metricsOpen}
        onOpenChange={setMetricsOpen}
        sessionId={selectedId}
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
          onRename={handleRenameSession}
          onDuplicate={handleDuplicate}
          onBatchDelete={handleBatchDelete}
          onDeleteAll={handleDeleteAll}
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

        <main className="flex rounded-xl border bg-card overflow-hidden min-h-0">
          {!selectedId ? (
            <EmptyChatState
              onNew={handleNewSession}
              projectName={projectName}
              onOpenSidebar={() => setMobileSidebarOpen(true)}
            />
          ) : (
            <>
              <div className="flex-1 min-w-0 min-h-0 flex flex-col">
              {sessionData?.session && (
                <ChatHeader
                  session={sessionData.session}
                  streaming={streaming}
                  runDelta={runDelta}
                  lastUsage={lastUsage}
                  stats={stats}
                  contextStatus={contextStatus}
                  indexStatus={indexStatus}
                  onOpenDetails={() => setDetailsOpen(true)}
                  onOpenSidebar={() => setMobileSidebarOpen(true)}
                  onOpenToolConfig={() => setToolConfigOpen(true)}
                  onOpenSkillConfig={() => setSkillConfigOpen(true)}
                  onOpenMetrics={() => setMetricsOpen(true)}
                  onOpenSnapshots={() => setSnapshotsOpen(true)}
                  pendingSnapshots={snapshotPending}
                />
              )}
              <div className="flex-1 min-h-0 overflow-hidden flex flex-col">
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
              <Composer
                ref={composerRef}
                filePicks={filePicks}
                onRemovePick={togglePick}
                onClearPicks={clearPicks}
                skillPicks={skillPicks}
                onRemoveSkillPick={toggleSkillPick}
                onClearSkillPicks={clearSkillPicks}
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
                thinking={thinking}
                setThinking={setThinking}
                supportsThinking={providerSupportsThinking(provider, providerOptions, model)}
                fallbackProvider={fallbackProvider}
                fallbackModel={fallbackModel}
                onFallbackChange={handleFallbackChange}
                temperature={sessionTemperature}
                setTemperature={handleTemperatureChange}
                unrestrictedOutput={unrestrictedOutput}
                setUnrestrictedOutput={handleUnrestrictedOutputChange}
                getModelsForProvider={getModelsForProvider}
                selectedPipelineId={selectedPipelineId}
                setSelectedPipelineId={setSelectedPipelineId}
                onRunPipeline={handleRunPipeline}
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
              </div>
              {sessionData?.session && (
                <SessionStateSidebar
                  sessionId={sessionData.session.id}
                  refreshKey={stateRefreshKey + sidebarRefreshTick}
                  todos={todos}
                  projectId={projectId}
                  filePicks={filePicks}
                  onTogglePick={togglePick}
                  onSetManyPicks={setManyPicks}
                  onClearPicks={clearPicks}
                  skillPicks={skillPicks}
                  onToggleSkillPick={toggleSkillPick}
                  pipelineRuntime={pipelineRuntime}
                />
              )}
            </>
          )}
        </main>
      </div>
      {selectedId != null && (
        <Dialog open={snapshotsOpen} onOpenChange={setSnapshotsOpen}>
          <DialogContent
            className="p-0 gap-0 max-w-[100vw] sm:max-w-[1400px] w-[100vw] sm:w-[95vw] h-[100dvh] sm:h-[90vh] sm:max-h-[90vh] rounded-none sm:rounded-xl overflow-hidden flex flex-col"
          >
            <DialogHeader className="px-4 py-2.5 border-b bg-card flex-shrink-0">
              <DialogTitle className="text-sm">Session Snapshots</DialogTitle>
              <DialogDescription className="sr-only">
                Review every file altered by the agent in this session. Accept or revert per hunk, per file, or all at once.
              </DialogDescription>
            </DialogHeader>
            <div className="flex-1 min-h-0">
              <SnapshotsPanel scope="coder" sessionId={selectedId} refreshKey={snapshotTick} />
            </div>
          </DialogContent>
        </Dialog>
      )}
    </TooltipProvider>
  );
}
