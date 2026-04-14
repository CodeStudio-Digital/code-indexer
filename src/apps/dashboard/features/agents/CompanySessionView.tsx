import React, { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Send, StopCircle, Users, FolderGit2, Bot, Crown, RefreshCw, AlertCircle, CheckCircle, XCircle, HelpCircle, PanelRight, PanelRightClose, MessageSquare, KanbanSquare, Check } from 'lucide-react';
import { Badge } from '../../components/ui/badge.js';
import { Button } from '../../components/ui/button.js';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../../components/ui/tabs.js';
import { cn } from '../../lib/utils.js';
import { useApi } from '../../hooks/useApi.js';
import { useCompanyStream } from '../../hooks/useCompanyStream.js';
import { useProviders } from '../../hooks/useProviders.js';
import { AgentPane } from './AgentPane.js';
import { BoardPanel } from './BoardPanel.js';
import { KanbanTab } from './KanbanTab.js';
import { AgentSessionModal } from './AgentSessionModal.js';
import { MarkdownToolbar } from '../chat/composer/MarkdownToolbar.js';
import { useMarkdownShortcuts } from '../chat/composer/useMarkdownShortcuts.js';

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
}

export function CompanySessionView({ sessionId, sessionName, sessionStatus }: CompanySessionViewProps) {
  const { t } = useTranslation(['agents', 'common']);
  const stream = useCompanyStream(sessionId);
  const { data: sessionData, refetch } = useApi<SessionFullData>(`/company/sessions/${sessionId}`);
  const [input, setInput] = useState('');
  const [agentPanelOpen, setAgentPanelOpen] = useState(false);
  const [modalSession, setModalSession] = useState<{ coderSessionId: number; role: string; status: string } | null>(null);
  const [editingRoleIdx, setEditingRoleIdx] = useState<number | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const { handleKeyDown: mdHandleKeyDown, applyAction } = useMarkdownShortcuts(textareaRef, input, setInput);
  const { providerOptions, getModelsForProvider, getDefaultModel } = useProviders();

  // Reset stream state when switching sessions
  useEffect(() => { stream.reset(); }, [sessionId]);

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

  const subordinates = Array.from(stream.subordinateStates.values());
  const config = sessionData ? parseConfig(sessionData.session.config_json) : null;

  // Session already has a run if status is not idle/draft — use sendMessage, not start
  const sessionAlreadyRan = sessionStatus === 'running' || sessionStatus === 'completed' || sessionStatus === 'paused' || sessionStatus === 'error';

  async function handleSend() {
    const text = input.trim();
    if (!text) return;
    setInput('');
    if (!stream.connected && (sessionAlreadyRan || stream.started)) {
      // Session ran before but is now disconnected — resume the master
      // from its existing coder session to keep full conversation history.
      await stream.resume(text);
      refetch();
    } else if (!stream.started && !sessionAlreadyRan) {
      await stream.start(text);
      refetch();
    } else {
      await stream.sendMessage(text);
    }
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    mdHandleKeyDown(e);
    if (e.key === 'Enter' && !e.shiftKey && !e.defaultPrevented) {
      e.preventDefault();
      handleSend();
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
          {stream.connected ? t('agents:company.live') : sessionStatus}
        </Badge>
        {sessionData?.projects.map((p) => (
          <Badge key={p.project_id} variant="outline" className="text-[10px] gap-1">
            <FolderGit2 className="h-2.5 w-2.5" />
            {p.project_name}
          </Badge>
        ))}
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
        {/* Mobile toggle for agents panel */}
        <button
          type="button"
          className={cn(
            'md:hidden p-1.5 rounded-md transition-colors shrink-0',
            !stream.masterState && 'ml-auto',
            agentPanelOpen
              ? 'bg-muted text-foreground'
              : 'text-muted-foreground hover:bg-muted hover:text-foreground',
          )}
          onClick={() => setAgentPanelOpen((v) => !v)}
          title={t('agents:company.toggleAgents')}
        >
          {agentPanelOpen ? <PanelRightClose className="h-4 w-4" /> : <PanelRight className="h-4 w-4" />}
        </button>
      </div>

      {/* INVERTED LAYOUT: Board (main) | Agents (sidebar right) */}
      <div className="flex-1 flex overflow-hidden">
        {/* Board — main area */}
        <div className="flex-1 flex flex-col overflow-hidden">
          {/* Error */}
          {stream.error && (
            <div className="mx-3 mt-3 p-3 rounded-lg border border-destructive/30 bg-destructive/5 text-xs text-destructive flex items-start gap-2">
              <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" />
              <p>{stream.error}</p>
            </div>
          )}

          {/* Plan approval */}
          {stream.pendingMasterPlan && (
            <div className="mx-3 mt-3">
              <PlanApprovalCard
                plan={stream.pendingMasterPlan.plan}
                onApprove={(fb) => stream.respondToMasterPlan(true, fb)}
                onReject={(fb) => stream.respondToMasterPlan(false, fb)}
              />
            </div>
          )}

          {/* Master question — ask_user routed through board */}
          {stream.pendingMasterQuestion && (
            <div className="mx-3 mt-3">
              <QuestionCard
                question={stream.pendingMasterQuestion.question}
                options={stream.pendingMasterQuestion.options}
                allowFreeform={stream.pendingMasterQuestion.allowFreeform}
                onAnswer={(answer) => stream.respondToMasterQuestion(answer)}
              />
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
            </TabsList>
            <TabsContent value="board" className="flex-1 overflow-hidden mt-0">
              <BoardPanel messages={boardMessages} />
            </TabsContent>
            <TabsContent value="kanban" className="flex-1 overflow-hidden mt-0">
              <KanbanTab companySessionId={sessionId} streamCards={stream.kanbanCards} />
            </TabsContent>
          </Tabs>

          {/* Composer */}
          <div className="border-t p-3">
            <div className="flex gap-2 items-end">
              <div className="flex-1 rounded-md border bg-background focus-within:ring-1 focus-within:ring-ring overflow-hidden">
                <textarea
                  ref={textareaRef}
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={handleKeyDown}
                  placeholder={!stream.started && !sessionAlreadyRan ? t('agents:company.inputPlaceholder') : t('agents:company.inputPlaceholderMaster')}
                  className="w-full resize-y px-3 py-2 text-sm min-h-[60px] max-h-[300px] bg-transparent focus:outline-none"
                  rows={3}
                />
                <MarkdownToolbar onAction={applyAction} />
              </div>
              <Button onClick={handleSend} disabled={!input.trim()} size="sm" className="h-9 shrink-0">
                <Send className="h-3.5 w-3.5" />
              </Button>
            </div>
          </div>
        </div>
        {/* Agent sidebar — right (hidden on mobile by default, toggle via PanelRight button) */}
        <div className={cn(
          'w-64 border-l flex-shrink-0 overflow-y-auto bg-muted/10 flex-col',
          agentPanelOpen ? 'flex' : 'hidden md:flex',
        )}>
          <div className="px-2.5 py-2 border-b flex items-center gap-1.5">
            <Bot className="h-3.5 w-3.5 text-muted-foreground" />
            <span className="text-xs font-medium">{t('agents:company.config')}</span>
          </div>
          <div className="p-2 space-y-2">
            <p className="text-sm font-medium"></p>

            {/* Projects */}
            {(sessionData?.projects.length ?? 0) > 0 && (
                <div>
                  <p className="text-[10px] text-muted-foreground uppercase tracking-wide mb-1.5">{t('agents:company.projects')}</p>
                  <div className="flex flex-wrap gap-1.5">
                    {sessionData?.projects.map((p) => (
                        <Badge key={p.project_id} variant="outline" className="text-[10px] gap-1">
                          <FolderGit2 className="h-2.5 w-2.5" />
                          {p.project_name}
                          {p.label && <span className="text-muted-foreground">({p.label})</span>}
                        </Badge>
                    ))}
                  </div>
                </div>
            )}

            {/* Roles — editable provider/model */}
            {config?.role_assignments && (config.role_assignments as unknown[]).length > 0 && (
                <div>
                  <p className="text-[10px] text-muted-foreground uppercase tracking-wide mb-1.5">{t('agents:company.configuredRoles')}</p>
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
    </div>
  );
}

function parseConfig(json: string): Record<string, unknown> | null {
  try { return JSON.parse(json); } catch { return null; }
}

function PlanApprovalCard({ plan, onApprove, onReject }: {
  plan: string;
  onApprove: (feedback?: string) => void;
  onReject: (feedback?: string) => void;
}) {
  const { t } = useTranslation(['agents', 'common']);
  const [feedback, setFeedback] = useState('');
  return (
    <div className="rounded-lg border-2 border-yellow-500/40 bg-yellow-500/5 p-4">
      <div className="flex items-center gap-2 mb-2">
        <Crown className="h-4 w-4 text-yellow-400" />
        <span className="text-sm font-medium">{t('agents:company.planApproval')}</span>
      </div>
      <div className="bg-background rounded-md border p-3 mb-3 text-xs whitespace-pre-wrap max-h-60 overflow-y-auto">
        {plan}
      </div>
      <textarea
        value={feedback}
        onChange={(e) => setFeedback(e.target.value)}
        placeholder={t('agents:company.feedbackPlaceholder')}
        className="w-full rounded-md border bg-background px-3 py-1.5 text-xs resize-none mb-2"
        rows={2}
      />
      <div className="flex gap-2">
        <Button size="sm" variant="default" onClick={() => onApprove(feedback || undefined)} className="gap-1">
          <CheckCircle className="h-3.5 w-3.5" /> {t('common:actions.approve')}
        </Button>
        <Button size="sm" variant="outline" onClick={() => onReject(feedback || undefined)} className="gap-1 text-destructive">
          <XCircle className="h-3.5 w-3.5" /> {t('common:actions.reject')}
        </Button>
      </div>
    </div>
  );
}

function QuestionCard({ question, options, allowFreeform, onAnswer }: {
  question: string;
  options?: Array<{ label: string; value: string }>;
  allowFreeform?: boolean;
  onAnswer: (answer: string) => void;
}) {
  const [text, setText] = useState('');
  const { t } = useTranslation(['agents', 'common']);
  const showTextInput = !options || allowFreeform;

  return (
    <div className="rounded-lg border-2 border-blue-500/40 bg-blue-500/5 p-4">
      <div className="flex items-center gap-2 mb-2">
        <HelpCircle className="h-4 w-4 text-blue-400" />
        <span className="text-sm font-medium">{t('agents:company.masterQuestion')}</span>
      </div>
      <p className="text-sm mb-3 whitespace-pre-wrap">{question}</p>

      {/* Option buttons */}
      {options && options.length > 0 && (
        <div className="flex flex-wrap gap-2 mb-3">
          {options.map((opt) => (
            <Button
              key={opt.value}
              size="sm"
              variant="outline"
              onClick={() => onAnswer(opt.value)}
            >
              {opt.label}
            </Button>
          ))}
        </div>
      )}

      {/* Free-form text input */}
      {showTextInput && (
        <div className="flex gap-2">
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={t('agents:company.answerPlaceholder')}
            className="flex-1 rounded-md border bg-background px-3 py-1.5 text-xs resize-none"
            rows={2}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && text.trim()) {
                e.preventDefault();
                onAnswer(text.trim());
              }
            }}
          />
          <Button
            size="sm"
            variant="default"
            onClick={() => text.trim() && onAnswer(text.trim())}
            disabled={!text.trim()}
            className="self-end gap-1"
          >
            <Send className="h-3.5 w-3.5" /> {t('agents:company.answer')}
          </Button>
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
