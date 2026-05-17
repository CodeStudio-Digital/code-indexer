import React, { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { StopCircle, Users, FolderGit2, Bot, Crown, RefreshCw, AlertCircle, PanelLeft, PanelLeftClose, MessageSquare, KanbanSquare, Check, Plus, BookText, BookOpen, KeyRound, X, Archive, RotateCcw, Database, FlaskConical, Network, Inbox, FolderOpen, GitCompare } from 'lucide-react';
import { TestsTab } from './tests/TestsTab.js';
import { QaRunBadge } from './tests/shared/QaRunBadge.js';
import DocsTab from './DocsTab.js';
import DatabasesTab from './DatabasesTab.js';
import ServicesSidebar from './ServicesSidebar.js';
import EnvTab from './EnvTab.js';
import { Badge } from '../../components/ui/badge.js';
import { Button } from '../../components/ui/button.js';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../../components/ui/tabs.js';
import { cn } from '../../lib/utils.js';
import { useApi, apiPost } from '../../hooks/useApi.js';
import { useCompanyStream } from '../../hooks/useCompanyStream.js';
import type { AgentAttachment } from '../../hooks/agent-stream/types.js';
import type { MasterPrompt } from '@mcp/company/types.js';
import { useProviders } from '../../hooks/useProviders.js';
import { providerSupportsThinking } from '../chat/composer/provider-caps.js';
import { AgentPane } from './AgentPane.js';
import { BoardPanel } from './BoardPanel.js';
import { KanbanTab } from './KanbanTab.js';
import { PipelinesTab } from './PipelinesTab.js';
import { InboxPanel } from './InboxPanel.js';
import { DrivePanel } from './DrivePanel.js';
import { AgentSessionModal } from './AgentSessionModal.js';
import { MasterComposer } from './MasterComposer.js';
import { FrontTabsBar } from './FrontTabsBar.js';
import { useCompanySiblings } from '../../hooks/useCompanySiblings.js';
import { ResetSessionDialog } from './ResetSessionDialog.js';
import { ArchivedTab } from './ArchivedTab.js';
import { CompanyApiReferenceTab } from './CompanyApiReferenceTab.js';
import { RoleEditModal, type RoleConfig, type SkillDef } from './RoleEditModal.js';
import { SnapshotsPanel } from '../snapshots/SnapshotsPanel.js';

interface Project {
  id: number;
  name: string;
  root_path: string;
}

interface CompanySessionViewProps {
  sessionId: number;
  sessionName: string;
  sessionStatus: string;
}

interface SessionFullData {
  session: { id: number; name: string; status: string; config_json: string; template_id: number | null; last_user_message?: string | null };
  projects: Array<{ project_id: number; project_name: string; root_path: string; label: string | null }>;
  agentRuns: Array<{ id: number; role: string; status: string; provider: string; model: string; project_ids_json: string; coder_session_id: number }>;
  recentBoard: Array<{ id: number; author_role: string; agent_run_id: number | null; kind: string; content: string; mentions_json: string; created_at: string }>;
  /**
   * Pending + recently-resolved master prompts (ask_user / submit_plan).
   * Used to rehydrate `stream.masterPrompts` on first load so a tab that
   * opens with the master already blocked on a question shows the card
   * immediately (no SSE event needed). Backed by the `getCompanySessionFull`
   * route's `masterPrompts` field.
   */
  masterPrompts?: MasterPrompt[];
}

export function CompanySessionView({ sessionId, sessionName, sessionStatus }: CompanySessionViewProps) {
  const { t } = useTranslation(['agents', 'common']);
  // Multi-front (migration 067): the URL identifies the ROOT session
  // (parent of the tab tree). The active tab can be the parent itself
  // ("Main") or any non-archived child. `useCompanyStream` is mounted
  // on the active id, so switching tabs gives us a clean stream of
  // that sub-session's board / agents / prompts.
  const siblings = useCompanySiblings(sessionId);
  const activeSessionId = siblings.activeSessionId ?? sessionId;
  const stream = useCompanyStream(activeSessionId);
  const { data: sessionData, refetch } = useApi<SessionFullData>(`/company/sessions/${activeSessionId}`);
  const [agentPanelOpen, setAgentPanelOpen] = useState(true);
  const [modalSession, setModalSession] = useState<{ coderSessionId: number; role: string; status: string } | null>(null);
  const [editingRoleIdx, setEditingRoleIdx] = useState<number | null>(null);
  const [addingProject, setAddingProject] = useState(false);
  const [newProjectId, setNewProjectId] = useState('');
  const [resetDialogOpen, setResetDialogOpen] = useState(false);
  const [newRoleDraft, setNewRoleDraft] = useState<RoleConfig | null>(null);
  const [newRoleError, setNewRoleError] = useState<string | null>(null);
  const { data: allProjects } = useApi<Project[]>('/projects');
  const { data: skillsList } = useApi<{ skills: SkillDef[] }>('/admin/skills');
  const { providerOptions, getModelsForProvider, getDefaultModel } = useProviders();

  // Reset stream state when the active sub-session changes (tab switch
  // or explicit session change). Each sub-session has its own metaBus
  // and own state — re-mounting the hook on a fresh id does the rest.
  useEffect(() => { stream.reset(); }, [activeSessionId]);

  // Hydrate pending master prompts from the initial /sessions/:id load.
  // Without this, a tab that opens while the master is already blocked
  // on `ask_user` shows nothing in the feed until the user pokes the
  // session — the SSE event may have fired before the client connected
  // (or before the tab was even open).
  useEffect(() => {
    if (sessionData?.masterPrompts) {
      stream.hydrateMasterPrompts(sessionData.masterPrompts);
    }
  }, [sessionData?.masterPrompts]);

  // On mount, attempt ONE reattach if the session is already running.
  // The cleanup fn resets the flag so navigating away and back retries once more.
  // We intentionally do NOT put stream.connected in the dep array — doing so
  // creates an infinite loop (reattach → 404 → connected=false → effect fires → …).
  const reattachAttemptedRef = useRef(false);
  useEffect(() => {
    reattachAttemptedRef.current = false; // reset whenever sessionId changes
    if ((sessionStatus === 'running' || sessionStatus === 'paused') && !stream.connected) {
      reattachAttemptedRef.current = true;
      stream.reattach();
    }
    return () => { reattachAttemptedRef.current = false; }; // reset on unmount
  }, [sessionId, sessionStatus]);

  // Sub-session isolation is now enforced at the FK level: agent_runs /
  // board / prompts all key on `company_session_id`, so each tab's
  // stream only ever carries its own data. No client-side filtering.
  const subordinates = Array.from(stream.subordinateStates.values());
  const config = sessionData ? parseConfig(sessionData.session.config_json) : null;
  const masterProvider = (config?.master_provider as string | undefined) ?? null;
  const masterModel = (config?.master_model as string | undefined) ?? null;
  const masterSupportsThinking = providerSupportsThinking(masterProvider, providerOptions, masterModel);

  // Session already has a run if status is not idle/draft — use sendMessage, not start
  const sessionAlreadyRan = sessionStatus === 'running' || sessionStatus === 'completed' || sessionStatus === 'paused' || sessionStatus === 'error';

  async function handleSend(text: string, attachments: AgentAttachment[], opts?: { thinking?: boolean }) {
    if (!stream.connected && (sessionAlreadyRan || stream.started)) {
      // Session ran before but is now disconnected — resume the master
      // from its existing coder session to keep full conversation history.
      await stream.resume(text, attachments, opts);
      refetch();
    } else if (!stream.started && !sessionAlreadyRan) {
      await stream.start(text, attachments, opts);
      refetch();
    } else {
      await stream.sendMessage(text, attachments, opts);
    }
  }

  function openAgentSession(agentRunId: number, role: string, status: string) {
    // Find coder_session_id from persisted data or stream state
    const persistedRun = sessionData?.agentRuns.find((r) => r.id === agentRunId);
    const coderSessionId = persistedRun?.coder_session_id;
    if (coderSessionId) {
      setModalSession({ coderSessionId, role, status });
    }
  }

  // Merge board from stream and persisted
  const boardMessages = stream.boardMessages.length > 0
    ? stream.boardMessages
    : (sessionData?.recentBoard ?? []).map((b) => ({
        ...b,
        mentions: JSON.parse(b.mentions_json || '[]'),
      }));

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="px-4 py-2.5 border-b flex items-center gap-2 flex-wrap">
        <Users className="h-4 w-4 text-muted-foreground" />
        <h2 className="text-sm font-semibold">{sessionName}</h2>
        <Badge variant={stream.connected ? 'default' : 'outline'} className="text-[10px]">
          {stream.connected ? t('agents:company.live') : (sessionData?.session.status ?? sessionStatus)}
        </Badge>
        {(() => {
          const running = siblings.children.filter((c) => c.status === 'running').length
            + (siblings.parent?.status === 'running' ? 1 : 0);
          const total = siblings.children.length + (siblings.parent ? 1 : 0);
          return total > 1 && running > 0 ? (
            <span className="text-[10px] text-muted-foreground">{running}/{total} fronts</span>
          ) : null;
        })()}
        {sessionData?.projects.map((p) => (
          <Badge key={p.project_id} variant="outline" className="text-[10px] gap-1">
            <FolderGit2 className="h-2.5 w-2.5" />
            {p.project_name}
          </Badge>
        ))}
        <QaRunBadge sessionId={sessionId} />
        {stream.masterState && (
          <Badge variant="outline" className="text-[10px] ml-auto gap-1 capitalize">
            <Crown className="h-2.5 w-2.5 text-yellow-400" />
            Master: {stream.masterState.status}
          </Badge>
        )}
        {stream.connected && (
          <Button variant="ghost" size="sm" onClick={stream.abort} className="h-7 px-2 text-destructive">
            <StopCircle className="h-3.5 w-3.5 mr-1" /> {t('agents:company.stopAll')}
          </Button>
        )}
        {!stream.connected && sessionStatus === 'running' && stream.started && (
          <Button variant="ghost" size="sm" onClick={() => stream.reattach()} className="h-7 px-2 text-muted-foreground">
            <RefreshCw className="h-3.5 w-3.5 mr-1" /> {t('agents:company.reconnect')}
          </Button>
        )}
        {/* Reset: archives the current conversation state and flips the
            session back to idle so the next prompt starts fresh with
            current system prompts. Useful after template/prompt updates. */}
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setResetDialogOpen(true)}
          className="h-7 px-2 text-muted-foreground"
          title="Resetar sessão — arquiva conversas e permite recomeçar do zero"
        >
          <RotateCcw className="h-3.5 w-3.5 mr-1" /> Reset
        </Button>
        {/* Toggle for agents panel */}
        <button
          type="button"
          className={cn(
            'p-1.5 rounded-md transition-colors shrink-0',
            !stream.masterState && 'ml-auto',
            agentPanelOpen
              ? 'bg-muted text-foreground'
              : 'text-muted-foreground hover:bg-muted hover:text-foreground',
          )}
          onClick={() => setAgentPanelOpen((v) => !v)}
          title={t('agents:company.toggleAgents')}
        >
          {agentPanelOpen ? <PanelLeftClose className="h-4 w-4" /> : <PanelLeft className="h-4 w-4" />}
        </button>
      </div>

      {/* LAYOUT: Agents (sidebar left) | Board (main) */}
      <div className="flex-1 flex overflow-hidden">
        {/* Agent sidebar — LEFT (collapsible on all breakpoints) */}
        <div className={cn(
          'w-64 border-r flex-shrink-0 overflow-y-auto bg-muted/10 flex-col',
          agentPanelOpen ? 'flex' : 'hidden',
        )}>
          <div className="px-2.5 py-2 border-b flex items-center gap-1.5">
            <Bot className="h-3.5 w-3.5 text-muted-foreground" />
            <span className="text-xs font-medium">{t('agents:company.config')}</span>
          </div>
          <div className="p-2 space-y-2">
            <p className="text-sm font-medium"></p>

            {/* Projects */}
            <div>
              <div className="flex items-center justify-between mb-1.5">
                <p className="text-[10px] text-muted-foreground uppercase tracking-wide">{t('agents:company.projects')}</p>
                <button
                  type="button"
                  onClick={() => { setAddingProject((v) => !v); setNewProjectId(''); }}
                  className="text-muted-foreground hover:text-foreground transition-colors"
                  title="Add project"
                >
                  <Plus className="h-3 w-3" />
                </button>
              </div>
              <div className="flex flex-wrap gap-1.5">
                {sessionData?.projects.map((p) => (
                  <ProjectBadge
                    key={p.project_id}
                    projectId={p.project_id}
                    name={p.project_name}
                    label={p.label}
                    onRenamed={refetch}
                    canDelete={(sessionData?.projects.length ?? 0) > 1}
                    onDelete={async () => {
                      const isService = !!p.label;
                      const confirmMsg = isService
                        ? `Remover microserviço '${p.label}'? O container e os arquivos serão destruídos.`
                        : `Desvincular '${p.project_name}' desta sessão? O projeto continua disponível em outras sessões.`;
                      if (!confirm(confirmMsg)) return;
                      const r = await fetch(
                        `/api/company/sessions/${sessionId}/projects/${p.project_id}`,
                        { method: 'DELETE' },
                      );
                      if (!r.ok) {
                        const body = (await r.json().catch(() => ({}))) as { error?: string };
                        alert(body.error ?? `HTTP ${r.status}`);
                        return;
                      }
                      refetch();
                    }}
                  />
                ))}
              </div>
              {addingProject && (() => {
                const available = (allProjects ?? []).filter(
                  (p) => !sessionData?.projects.some((sp) => sp.project_id === p.id),
                );
                return available.length > 0 ? (
                  <div className="flex gap-1 mt-1.5">
                    <select
                      value={newProjectId}
                      onChange={(e) => setNewProjectId(e.target.value)}
                      className="flex-1 rounded border bg-background px-1 py-0.5 text-[10px]"
                    >
                      <option value="">Select...</option>
                      {available.map((p) => (
                        <option key={p.id} value={String(p.id)}>{p.name}</option>
                      ))}
                    </select>
                    <button
                      type="button"
                      disabled={!newProjectId}
                      className="disabled:opacity-40 text-muted-foreground hover:text-foreground transition-colors"
                      onClick={async () => {
                        await apiPost(`/company/sessions/${sessionId}/projects`, { project_id: Number(newProjectId) });
                        setNewProjectId('');
                        setAddingProject(false);
                        refetch();
                      }}
                    >
                      <Check className="h-3 w-3" />
                    </button>
                  </div>
                ) : (
                  <p className="text-[10px] text-muted-foreground mt-1">{t('agents:company.noMoreProjects', 'No more projects available')}</p>
                );
              })()}
            </div>

            {/* Agents per project — source of truth for the master's
                "which role works on which project" routing. Rendered
                project-first because that's how the operator thinks
                ("this project is the frontend → who works here?"). */}
            {sessionData?.projects.length && config?.role_assignments && (config.role_assignments as unknown[]).length > 0 ? (
              <ProjectRolesBinding
                projects={sessionData.projects}
                roleAssignments={config.role_assignments as RoleAssignmentRaw[]}
                onUpdate={async (updated) => {
                  try {
                    await fetch(`/api/company/sessions/${sessionId}/config`, {
                      method: 'PATCH',
                      headers: { 'content-type': 'application/json' },
                      body: JSON.stringify({ role_assignments: updated }),
                    });
                  } catch { /* non-fatal; user will see stale state on next refetch */ }
                  refetch();
                }}
              />
            ) : null}

            {/* Roles — editable provider/model */}
            {config?.role_assignments && (config.role_assignments as unknown[]).length > 0 && (
                <div>
                  <div className="flex items-center justify-between mb-1.5">
                    <p className="text-[10px] text-muted-foreground uppercase tracking-wide">{t('agents:company.configuredRoles')}</p>
                    <button
                      type="button"
                      onClick={() => {
                        const pool = (config.allowed_models as Array<{ provider: string; model: string; is_default?: boolean }> | undefined) ?? [];
                        const poolPick = pool.find((e) => e.is_default) ?? pool[0] ?? null;
                        const masterRow = (config.role_assignments as Array<Record<string, string>>).find((x) => x.role === 'master');
                        const defaultProvider = poolPick?.provider ?? masterRow?.provider ?? providerOptions[0]?.id ?? 'anthropic';
                        const defaultModel = poolPick?.model ?? masterRow?.model ?? getDefaultModel(defaultProvider);
                        setNewRoleDraft({
                          role: '',
                          provider: defaultProvider,
                          model: defaultModel,
                          tier: 'navigate',
                        });
                        setNewRoleError(null);
                      }}
                      className="text-muted-foreground hover:text-foreground transition-colors"
                      title={t('agents:company.addRole')}
                    >
                      <Plus className="h-3 w-3" />
                    </button>
                  </div>
                  <div className="space-y-1">
                    {(config.role_assignments as Array<Record<string, string>>).map((r, i) => (
                        <div key={i} className="rounded border p-1.5 space-y-1">
                          <div
                            className="flex items-center gap-2 text-[10px] cursor-pointer hover:bg-muted/50 rounded px-1 py-0.5"
                            onClick={() => setEditingRoleIdx(editingRoleIdx === i ? null : i)}
                          >
                            {r.role === 'master' ? (
                                <Crown className="h-3 w-3 text-yellow-400 shrink-0" />
                            ) : (
                                <Bot className="h-3 w-3 text-muted-foreground shrink-0" />
                            )}
                            <span className="capitalize font-medium truncate flex-1">{r.role}</span>
                            <span className="text-muted-foreground text-[9px] truncate max-w-[100px]">{r.provider}/{r.model}</span>
                            {r.tier && <Badge variant="outline" className="text-[9px] px-1">{r.tier}</Badge>}
                          </div>
                          {editingRoleIdx === i && (
                            <RoleModelEditor
                              role={r}
                              providerOptions={providerOptions}
                              getModelsForProvider={getModelsForProvider}
                              getDefaultModel={getDefaultModel}
                              onApply={async (provider, model) => {
                                const roles = config.role_assignments as Array<Record<string, string>>;
                                const updated = roles.map((role, idx) =>
                                  idx === i ? { ...role, provider, model } : role,
                                );
                                const isMaster = r.role === 'master';
                                await stream.switchProvider(
                                  isMaster ? provider : (config.master_provider as string) ?? roles.find((x) => x.role === 'master')?.provider ?? provider,
                                  isMaster ? model : (config.master_model as string) ?? roles.find((x) => x.role === 'master')?.model,
                                  updated as Array<{ role: string; provider: string; model: string; tier: string }>,
                                );
                                // Persist via PATCH /config so the edit
                                // survives server restart and is the
                                // source of truth on next boot. The
                                // orchestrator.applyConfigPatch path
                                // also re-broadcasts to running agents
                                // — harmless when switchProvider above
                                // already handled the live swap.
                                try {
                                  await fetch(
                                    `/api/company/sessions/${sessionId}/config`,
                                    {
                                      method: 'PATCH',
                                      headers: { 'content-type': 'application/json' },
                                      body: JSON.stringify({ role_assignments: updated }),
                                    },
                                  );
                                } catch {
                                  /* non-fatal: runtime swap already happened */
                                }
                                setEditingRoleIdx(null);
                                refetch();
                              }}
                            />
                          )}
                        </div>
                    ))}
                  </div>
                </div>
            )}
          </div>

          <ServicesSidebar sessionId={sessionId} />

          <div className="px-2.5 py-2 border-b border-t flex items-center gap-1.5">
            <Bot className="h-3.5 w-3.5 text-muted-foreground" />
            <span className="text-xs font-medium">{t('agents:company.agentsLabel')}</span>
            <Badge variant="outline" className="text-[9px] ml-auto">
              {(stream.masterState ? 1 : 0) + subordinates.length}
            </Badge>
          </div>

          <div className="p-2 space-y-2">
            {/* Master */}
            {stream.masterState && (
              <AgentPane
                agent={stream.masterState}
                onClick={() => {
                  const masterRun = sessionData?.agentRuns.find((r) => r.role === 'master');
                  if (masterRun) openAgentSession(masterRun.id, 'master', stream.masterState!.status);
                }}
              />
            )}

            {/* Streaming subordinates */}
            {subordinates.map((agent) => (
              <AgentPane
                key={agent.agentRunId}
                agent={agent}
                onClick={() => openAgentSession(agent.agentRunId, agent.role, agent.status)}
              />
            ))}

            {/* Persisted agent runs (when not streaming) */}
            {!stream.started && sessionData?.agentRuns.map((run) => (
              <div
                key={run.id}
                role="button"
                tabIndex={0}
                onClick={() => setModalSession({ coderSessionId: run.coder_session_id, role: run.role, status: run.status })}
                onKeyDown={(e) => e.key === 'Enter' && setModalSession({ coderSessionId: run.coder_session_id, role: run.role, status: run.status })}
                className="flex items-center gap-1.5 text-[10px] p-2 rounded border cursor-pointer hover:bg-muted/50"
              >
                {run.role === 'master' ? <Crown className="h-3 w-3 text-yellow-400" /> : <Bot className="h-3 w-3 text-muted-foreground" />}
                <span className="font-medium capitalize truncate">{run.role}</span>
                <Badge variant="outline" className="text-[8px] ml-auto capitalize">{run.status}</Badge>
              </div>
            ))}

            {/* Empty state */}
            {!stream.masterState && !subordinates.length && (!sessionData?.agentRuns || sessionData.agentRuns.length === 0) && (
              <p className="text-[10px] text-muted-foreground text-center py-3">
                {t('agents:company.noAgents')}
              </p>
            )}

            {/* Config summary */}
            {config?.role_assignments && (config.role_assignments as unknown[]).length > 0 && (
              <div className="border-t pt-2 mt-2">
                <p className="text-[9px] text-muted-foreground uppercase tracking-wide mb-1">{t('agents:company.templateRoles')}</p>
                {(config.role_assignments as Array<Record<string, string>>).map((r, i) => (
                  <div key={i} className="text-[10px] text-muted-foreground flex items-center gap-1 py-0.5">
                    <Bot className="h-2.5 w-2.5" />
                    <span className="capitalize">{r.role}</span>
                    <span className="ml-auto text-[9px]">{r.provider}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Board — main area */}
        <div className="flex-1 flex flex-col overflow-hidden">
          {/* Error */}
          {stream.error && (
            <div className="mx-3 mt-3 p-3 rounded-lg border border-destructive/30 bg-destructive/5 text-xs text-destructive flex items-start gap-2">
              <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" />
              <p>{stream.error}</p>
            </div>
          )}


          {/* Loading */}
          {stream.started && !stream.masterState && !stream.error && (
            <div className="flex items-center justify-center py-8">
              <RefreshCw className="h-5 w-5 animate-spin text-muted-foreground" />
              <span className="ml-2 text-sm text-muted-foreground">{t('agents:company.startingMaster')}</span>
            </div>
          )}

          {/* Board + Kanban tabs — takes remaining space */}
          <Tabs defaultValue="board" className="flex-1 flex flex-col overflow-hidden">
            <TabsList className="mx-3 mt-2 w-fit">
              <TabsTrigger value="board" className="text-xs gap-1">
                <MessageSquare className="h-3 w-3" /> {t('agents:company.board')}
              </TabsTrigger>
              <TabsTrigger value="kanban" className="text-xs gap-1">
                <KanbanSquare className="h-3 w-3" /> {t('agents:company.kanban')}
              </TabsTrigger>
              <TabsTrigger value="pipelines" className="text-xs gap-1">
                <Network className="h-3 w-3" /> {t('agents:company.pipelines')}
              </TabsTrigger>
              <TabsTrigger value="inbox" className="text-xs gap-1">
                <Inbox className="h-3 w-3" /> {t('agents:company.inbox')}
              </TabsTrigger>
              <TabsTrigger value="drive" className="text-xs gap-1">
                <FolderOpen className="h-3 w-3" /> Drive
              </TabsTrigger>
              <TabsTrigger value="tests" className="text-xs gap-1">
                <FlaskConical className="h-3 w-3" /> Testes
              </TabsTrigger>
              <TabsTrigger value="docs" className="text-xs gap-1">
                <BookText className="h-3 w-3" /> {t('agents:company.docs')}
              </TabsTrigger>
              <TabsTrigger value="api" className="text-xs gap-1">
                <BookOpen className="h-3 w-3" /> {t('agents:company.apiReference')}
              </TabsTrigger>
              <TabsTrigger value="env" className="text-xs gap-1">
                <KeyRound className="h-3 w-3" /> {t('agents:company.env')}
              </TabsTrigger>
              <TabsTrigger value="databases" className="text-xs gap-1">
                <Database className="h-3 w-3" /> {t('agents:company.databases')}
              </TabsTrigger>
              <TabsTrigger value="snapshots" className="text-xs gap-1">
                <GitCompare className="h-3 w-3" /> Snapshots
              </TabsTrigger>
              <TabsTrigger value="archived" className="text-xs gap-1">
                <Archive className="h-3 w-3" /> {t('agents:company.archived')}
              </TabsTrigger>
            </TabsList>
            <TabsContent value="board" className="flex-1 overflow-hidden mt-0 flex flex-col">
              {siblings.parent && (
                <FrontTabsBar
                  parent={siblings.parent}
                  children={siblings.children}
                  activeSessionId={siblings.activeSessionId}
                  onSelect={siblings.setActiveSessionId}
                  onCreate={siblings.createChild}
                  onArchive={siblings.archiveChild}
                  onRename={siblings.renameChild}
                />
              )}
              <div className="flex-1 overflow-hidden">
                <BoardPanel
                  messages={boardMessages}
                  masterPrompts={Array.from(stream.masterPrompts.values())}
                  onAnswerQuestion={(promptId, answer) => stream.respondToMasterQuestion(promptId, answer)}
                  onRespondPlan={(promptId, approved, fb) => stream.respondToMasterPlan(promptId, approved, fb)}
                  sessionId={sessionId}
                  sessionName={sessionName}
                />
              </div>
            </TabsContent>
            <TabsContent value="kanban" className="flex-1 overflow-hidden mt-0">
              <KanbanTab companySessionId={sessionId} streamCards={stream.kanbanCards} />
            </TabsContent>
            <TabsContent value="pipelines" className="flex-1 overflow-hidden mt-0">
              <PipelinesTab companySessionId={sessionId} />
            </TabsContent>
            <TabsContent value="inbox" className="flex-1 overflow-hidden mt-0">
              <InboxPanel companySessionId={sessionId} />
            </TabsContent>
            <TabsContent value="drive" className="flex-1 overflow-hidden mt-0">
              <DrivePanel companySessionId={sessionId} />
            </TabsContent>
            <TabsContent value="tests" className="flex-1 overflow-hidden mt-0">
              <TestsTab sessionId={sessionId} />
            </TabsContent>
            <TabsContent value="docs" className="flex-1 overflow-hidden mt-0">
              <DocsTab companySessionId={sessionId} />
            </TabsContent>
            <TabsContent value="api" className="flex-1 overflow-hidden mt-0">
              <CompanyApiReferenceTab sessionId={sessionId} />
            </TabsContent>
            <TabsContent value="env" className="flex-1 overflow-hidden mt-0">
              <EnvTab companySessionId={sessionId} />
            </TabsContent>
            <TabsContent value="databases" className="flex-1 overflow-hidden mt-0">
              <DatabasesTab companySessionId={sessionId} />
            </TabsContent>
            <TabsContent value="snapshots" className="flex-1 overflow-hidden mt-0">
              <SnapshotsPanel scope="company" sessionId={sessionId} />
            </TabsContent>
            <TabsContent value="archived" className="flex-1 overflow-hidden mt-0">
              <ArchivedTab companySessionId={sessionId} />
            </TabsContent>
          </Tabs>

          {/* Composer */}
          <div className="border-t p-3">
            <MasterComposer
              onSend={handleSend}
              placeholder={!stream.started && !sessionAlreadyRan ? t('agents:company.inputPlaceholder') : t('agents:company.inputPlaceholderMaster')}
              supportsThinking={masterSupportsThinking}
            />
          </div>
        </div>
      </div>

      {/* Agent session modal */}
      {modalSession && (
        <AgentSessionModal
          coderSessionId={modalSession.coderSessionId}
          role={modalSession.role}
          status={modalSession.status}
          onClose={() => setModalSession(null)}
        />
      )}

      {/* Reset confirmation dialog */}
      {resetDialogOpen && (
        <ResetSessionDialog
          sessionId={sessionId}
          sessionName={sessionName}
          builderMode={!!(config && typeof config === 'object' && 'builder' in config && (config as { builder?: unknown }).builder)}
          onClose={() => setResetDialogOpen(false)}
          onResetDone={() => {
            // Full reload of session + stream state so the Board/Kanban
            // tabs go empty and next prompt hits /start (idle) instead
            // of /resume.
            stream.reset();
            refetch();
          }}
        />
      )}

      {/* Add-role modal — reuses the same form as the template builder.
          The Master learns about the new role immediately via
          updateRoleConfigs and decides when to spawn the subordinate. */}
      {newRoleDraft && (
        <div className="fixed inset-0 z-[55] flex flex-col items-center justify-end sm:justify-center">
          <RoleEditModal
            role={newRoleDraft}
            roleIdx={-1}
            availableSkills={skillsList?.skills ?? []}
            providerOptions={providerOptions}
            getModelsForProvider={getModelsForProvider}
            onCancel={() => {
              setNewRoleDraft(null);
              setNewRoleError(null);
            }}
            onUpdate={(patch) => {
              setNewRoleDraft((prev) => {
                if (!prev) return prev;
                const updated = { ...prev, ...patch };
                if (patch.provider && patch.provider !== prev.provider) {
                  updated.model = getDefaultModel(patch.provider);
                }
                return updated;
              });
            }}
            onClose={async () => {
              if (!newRoleDraft || !config) {
                setNewRoleDraft(null);
                return;
              }
              const roleName = newRoleDraft.role.trim();
              if (!roleName) {
                setNewRoleError(t('agents:company.roleNameRequired'));
                return;
              }
              if (roleName === 'master') {
                setNewRoleError(t('agents:company.reservedRoleName', { name: roleName }));
                return;
              }
              const existing = (config.role_assignments as Array<Record<string, string>>) ?? [];
              if (existing.some((r) => r.role === roleName)) {
                setNewRoleError(t('agents:company.duplicateRoleName', { name: roleName }));
                return;
              }
              const pool = (config.allowed_models as Array<{ provider: string; model: string }> | undefined) ?? [];
              if (pool.length > 0) {
                const inPool = pool.some((e) => e.provider === newRoleDraft.provider && e.model === newRoleDraft.model);
                if (!inPool) {
                  setNewRoleError(t('agents:company.modelNotInPool', {
                    provider: newRoleDraft.provider,
                    model: newRoleDraft.model,
                    options: pool.map((e) => `${e.provider}/${e.model}`).join(', '),
                  }));
                  return;
                }
              }
              const updatedRoles = [...existing, { ...newRoleDraft, role: roleName }];
              try {
                const res = await fetch(`/api/company/sessions/${sessionId}/config`, {
                  method: 'PATCH',
                  headers: { 'content-type': 'application/json' },
                  body: JSON.stringify({ role_assignments: updatedRoles }),
                });
                if (!res.ok) {
                  const body = (await res.json().catch(() => ({}))) as { error?: string };
                  setNewRoleError(body.error ?? `HTTP ${res.status}`);
                  return;
                }
              } catch (e) {
                setNewRoleError(e instanceof Error ? e.message : String(e));
                return;
              }
              setNewRoleDraft(null);
              setNewRoleError(null);
              refetch();
            }}
          />
          {newRoleError && (
            <div className="fixed bottom-4 left-1/2 -translate-x-1/2 z-[61] max-w-md rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive shadow-lg">
              {newRoleError}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function parseConfig(json: string): Record<string, unknown> | null {
  try { return JSON.parse(json); } catch { return null; }
}

/**
 * Shape used when we roundtrip `role_assignments` through the PATCH
 * endpoint. We only read/write a handful of fields here — the other
 * optionals (tier, skills, systemPromptOverride, etc.) pass through
 * untouched via object spread, so adding fields to the backend
 * interface later doesn't require changes here.
 */
type RoleAssignmentRaw = {
  role: string;
  provider: string;
  model: string;
  tier?: string;
  skills?: string[];
  projectHints?: string[];
  projectIds?: number[];
  systemPromptOverride?: string;
  [k: string]: unknown;
};

/**
 * "Agents per project" panel. Pivots the role_assignments array (where
 * the binding lives as `role.projectIds`) into a project-first view so
 * the operator thinks "who works on this project?" instead of "which
 * projects does this role touch?". The master's prompt mirrors this
 * view, and `spawn_subordinate_agent` enforces the binding.
 */
function ProjectRolesBinding({
  projects,
  roleAssignments,
  onUpdate,
}: {
  projects: Array<{ project_id: number; project_name: string; label: string | null }>;
  roleAssignments: RoleAssignmentRaw[];
  onUpdate: (updated: RoleAssignmentRaw[]) => void | Promise<void>;
}) {
  const { t } = useTranslation(['agents']);
  const nonMasterRoles = roleAssignments.filter((r) => r.role !== 'master');

  function rolesBoundTo(projectId: number): string[] {
    return nonMasterRoles
      .filter((r) => Array.isArray(r.projectIds) && r.projectIds!.includes(projectId))
      .map((r) => r.role);
  }

  function unboundForProject(projectId: number): string[] {
    const bound = new Set(rolesBoundTo(projectId));
    return nonMasterRoles.filter((r) => !bound.has(r.role)).map((r) => r.role);
  }

  function setBinding(roleName: string, nextIds: number[]) {
    const updated = roleAssignments.map((r) => {
      if (r.role !== roleName) return r;
      const trimmed = nextIds.length > 0 ? nextIds : undefined;
      const { projectIds: _drop, ...rest } = r;
      return trimmed ? { ...rest, projectIds: trimmed } : rest;
    });
    void onUpdate(updated);
  }

  function addRoleToProject(roleName: string, projectId: number) {
    const role = roleAssignments.find((r) => r.role === roleName);
    if (!role) return;
    const current = Array.isArray(role.projectIds) ? role.projectIds : [];
    if (current.includes(projectId)) return;
    setBinding(roleName, [...current, projectId]);
  }

  function removeRoleFromProject(roleName: string, projectId: number) {
    const role = roleAssignments.find((r) => r.role === roleName);
    if (!role || !Array.isArray(role.projectIds)) return;
    setBinding(roleName, role.projectIds.filter((id) => id !== projectId));
  }

  if (nonMasterRoles.length === 0) return null;

  return (
    <div>
      <p className="text-[10px] text-muted-foreground uppercase tracking-wide mb-1.5">
        {t('agents:projectAgents.title', 'Agents per project')}
      </p>
      <div className="space-y-1.5">
        {projects.map((p) => {
          const bound = rolesBoundTo(p.project_id);
          const available = unboundForProject(p.project_id);
          return (
            <div key={p.project_id} className="rounded border p-1.5 space-y-1">
              <div className="flex items-center gap-1 text-[10px] font-medium">
                <FolderGit2 className="h-2.5 w-2.5 text-muted-foreground" />
                <span className="truncate">{p.project_name}</span>
                {p.label && <span className="text-muted-foreground">[{p.label}]</span>}
              </div>
              <div className="flex flex-wrap gap-1 items-center">
                {bound.length === 0 && (
                  <span className="text-[9px] text-muted-foreground">
                    {t('agents:projectAgents.noRoles', 'No roles bound')}
                  </span>
                )}
                {bound.map((roleName) => (
                  <span
                    key={roleName}
                    className="inline-flex items-center gap-0.5 text-[9px] rounded-full border bg-muted/50 px-1.5 py-0.5"
                  >
                    <span className="capitalize">{roleName}</span>
                    <button
                      type="button"
                      onClick={() => removeRoleFromProject(roleName, p.project_id)}
                      className="text-muted-foreground hover:text-destructive transition-colors"
                      title={t('agents:projectAgents.removeRole', 'Unbind')}
                    >
                      <X className="h-2 w-2" />
                    </button>
                  </span>
                ))}
                {available.length > 0 && (
                  <AddRoleToProjectMenu
                    available={available}
                    onPick={(roleName) => addRoleToProject(roleName, p.project_id)}
                  />
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function AddRoleToProjectMenu({
  available,
  onPick,
}: {
  available: string[];
  onPick: (roleName: string) => void;
}) {
  const { t } = useTranslation('agents');
  const [open, setOpen] = React.useState(false);
  const ref = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    if (!open) return;
    function onDocClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [open]);

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="inline-flex items-center gap-0.5 text-[9px] rounded-full border border-dashed px-1.5 py-0.5 text-muted-foreground hover:text-foreground hover:border-solid transition-colors"
        title={t('agents:projectAgents.addRole', 'Add role')}
      >
        <Plus className="h-2 w-2" />
        <span>{t('agents:projectAgents.addRole', 'Add role')}</span>
      </button>
      {open && (
        <div className="absolute z-10 mt-1 min-w-[120px] rounded-md border bg-popover shadow-md py-1 text-[10px]">
          {available.map((roleName) => (
            <button
              key={roleName}
              type="button"
              onClick={() => { onPick(roleName); setOpen(false); }}
              className="w-full text-left px-2 py-1 hover:bg-muted capitalize"
            >
              {roleName}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function RoleModelEditor({ role, providerOptions, getModelsForProvider, getDefaultModel, onApply }: {
  role: Record<string, string>;
  providerOptions: Array<{ id: string; label: string }>;
  getModelsForProvider: (provider: string) => Array<{ id: string; name: string; mode?: string }>;
  getDefaultModel: (provider: string) => string;
  onApply: (provider: string, model: string) => void;
}) {
  const { t } = useTranslation('agents');
  const [provider, setProvider] = useState(role.provider);
  const [model, setModel] = useState(role.model);
  const models = getModelsForProvider(provider);

  function handleProviderChange(newProvider: string) {
    setProvider(newProvider);
    setModel(getDefaultModel(newProvider));
  }

  return (
    <div className="space-y-1.5 pt-1">
      <select
        value={provider}
        onChange={(e) => handleProviderChange(e.target.value)}
        className="w-full rounded border bg-background px-2 py-1 text-[10px]"
      >
        {providerOptions.map((p) => (
          <option key={p.id} value={p.id}>{p.label}</option>
        ))}
      </select>
      {models.length > 0 ? (
        <select
          value={model}
          onChange={(e) => setModel(e.target.value)}
          className="w-full rounded border bg-background px-2 py-1 text-[10px] font-mono"
        >
          {models.map((m) => (
            <option key={m.mode ? `${m.id}::${m.mode}` : m.id} value={m.id}>
              {m.name}{m.mode ? ` (${m.mode})` : ''}
            </option>
          ))}
        </select>
      ) : (
        <input
          value={model}
          onChange={(e) => setModel(e.target.value)}
          className="w-full rounded border bg-background px-2 py-1 text-[10px] font-mono"
          placeholder="model-name"
        />
      )}
      <Button
        size="sm"
        variant="default"
        className="w-full h-6 text-[10px] gap-1"
        disabled={provider === role.provider && model === role.model}
        onClick={() => onApply(provider, model)}
      >
        <Check className="h-2.5 w-2.5" /> {t('agents:kanban.card.apply')}
      </Button>
    </div>
  );
}

/**
 * Project chip with inline rename — click the name, edit, Enter/blur
 * commits via PATCH /api/projects/:id. Keeps the synthetic
 * `_BUILDER_<uuid>` IDs in the DB (they're used as idempotency keys
 * by the session delete cleanup) while letting users give them human
 * names they actually recognize.
 *
 * On double-click anywhere on the chip, and on the pencil icon, the
 * input takes focus. Escape discards; empty strings are rejected at
 * the API layer (projects.name has a NOT NULL + UNIQUE constraint).
 */
function ProjectBadge({
  projectId,
  name,
  label,
  onRenamed,
  onDelete,
  canDelete,
}: {
  projectId: number;
  name: string;
  label: string | null;
  onRenamed: () => void;
  onDelete: () => void | Promise<void>;
  canDelete: boolean;
}) {
  const [editing, setEditing] = React.useState(false);
  const [value, setValue] = React.useState(name);
  const [saving, setSaving] = React.useState(false);

  React.useEffect(() => setValue(name), [name]);

  async function save() {
    const trimmed = value.trim();
    if (!trimmed || trimmed === name) {
      setEditing(false);
      setValue(name);
      return;
    }
    setSaving(true);
    try {
      const r = await fetch(`/api/projects/${projectId}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: trimmed }),
      });
      if (r.ok) {
        onRenamed();
        setEditing(false);
      } else {
        const body = (await r.json().catch(() => ({}))) as { error?: string };
        alert(body.error ?? `HTTP ${r.status}`);
        setValue(name);
      }
    } finally {
      setSaving(false);
    }
  }

  if (editing) {
    return (
      <div className="inline-flex items-center gap-1 rounded border px-1.5 py-0.5 bg-background">
        <FolderGit2 className="h-2.5 w-2.5 text-muted-foreground" />
        <input
          className="text-[10px] bg-transparent outline-none w-40"
          value={value}
          autoFocus
          disabled={saving}
          onChange={(e) => setValue(e.target.value)}
          onBlur={save}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void save();
            else if (e.key === 'Escape') {
              setValue(name);
              setEditing(false);
            }
          }}
        />
      </div>
    );
  }

  return (
    <Badge
      variant="outline"
      className="text-[10px] gap-1 group/badge hover:bg-muted/50"
    >
      <FolderGit2
        className="h-2.5 w-2.5 cursor-pointer"
        onClick={() => setEditing(true)}
      />
      <span
        className="truncate max-w-[180px] cursor-pointer"
        title="Click to rename"
        onClick={() => setEditing(true)}
        onDoubleClick={() => setEditing(true)}
      >
        {name}
      </span>
      {label && <span className="text-muted-foreground">({label})</span>}
      {canDelete && (
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); void onDelete(); }}
          className="ml-0.5 opacity-0 group-hover/badge:opacity-100 text-muted-foreground hover:text-destructive transition-opacity"
          title={label ? 'Remove microservice (destroys container)' : 'Unlink project from session'}
        >
          <X className="h-2.5 w-2.5" />
        </button>
      )}
    </Badge>
  );
}
