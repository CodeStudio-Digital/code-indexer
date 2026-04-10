import React, { useEffect, useState } from 'react';
import { Send, StopCircle, Users, FolderGit2, Bot, Crown, RefreshCw, AlertCircle, CheckCircle, XCircle } from 'lucide-react';
import { Badge } from '../../components/ui/badge.js';
import { Button } from '../../components/ui/button.js';
import { useApi } from '../../hooks/useApi.js';
import { useCompanyStream } from '../../hooks/useCompanyStream.js';
import { AgentPane } from './AgentPane.js';
import { BoardPanel } from './BoardPanel.js';

interface CompanySessionViewProps {
  sessionId: number;
  sessionName: string;
  sessionStatus: string;
}

interface SessionFullData {
  session: {
    id: number;
    name: string;
    status: string;
    config_json: string;
    template_id: number | null;
  };
  projects: Array<{
    project_id: number;
    project_name: string;
    root_path: string;
    label: string | null;
  }>;
  agentRuns: Array<{
    id: number;
    role: string;
    status: string;
    provider: string;
    model: string;
    project_ids_json: string;
  }>;
  recentBoard: Array<{
    id: number;
    author_role: string;
    agent_run_id: number | null;
    kind: string;
    content: string;
    mentions_json: string;
    created_at: string;
  }>;
}

export function CompanySessionView({ sessionId, sessionName, sessionStatus }: CompanySessionViewProps) {
  const stream = useCompanyStream(sessionId);
  const { data: sessionData, refetch } = useApi<SessionFullData>(`/company/sessions/${sessionId}`);
  const [input, setInput] = useState('');

  // Reset stream state when switching sessions
  useEffect(() => {
    stream.reset();
  }, [sessionId]);

  // Try to reattach if session was already running
  useEffect(() => {
    if (sessionStatus === 'running' && !stream.connected && !stream.started) {
      stream.reattach();
    }
  }, [sessionId, sessionStatus]);

  const subordinates = Array.from(stream.subordinateStates.values());
  const config = sessionData ? parseConfig(sessionData.session.config_json) : null;
  const isIdle = sessionStatus === 'idle' && !stream.started;

  async function handleSend() {
    const text = input.trim();
    if (!text) return;
    setInput('');
    await stream.start(text);
    refetch();
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  }

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="px-4 py-3 border-b flex items-center gap-3 flex-wrap">
        <Users className="h-4 w-4 text-muted-foreground" />
        <h2 className="text-sm font-semibold">{sessionName}</h2>

        {/* Status */}
        <Badge variant={stream.connected ? 'default' : 'outline'} className="text-[10px]">
          {stream.connected ? 'Live' : sessionStatus}
        </Badge>

        {/* Project chips */}
        {sessionData?.projects.map((p) => (
          <Badge key={p.project_id} variant="outline" className="text-[10px] gap-1">
            <FolderGit2 className="h-2.5 w-2.5" />
            {p.project_name}
            {p.label && <span className="text-muted-foreground">({p.label})</span>}
          </Badge>
        ))}

        {/* Master status */}
        {stream.masterState && (
          <Badge variant="outline" className="text-[10px] ml-auto gap-1">
            <Crown className="h-2.5 w-2.5 text-yellow-400" />
            Master: {stream.masterState.status}
          </Badge>
        )}

        {/* Actions */}
        {stream.connected && (
          <Button variant="ghost" size="sm" onClick={stream.abort} className="h-7 px-2 text-destructive">
            <StopCircle className="h-3.5 w-3.5 mr-1" />
            Stop All
          </Button>
        )}
      </div>

      {/* Main content */}
      <div className="flex-1 flex overflow-hidden">
        {/* Board Panel — left */}
        <div className="w-72 border-r flex-shrink-0 overflow-hidden">
          <BoardPanel
            messages={stream.boardMessages.length > 0
              ? stream.boardMessages
              : (sessionData?.recentBoard ?? []).map((b) => ({
                  ...b,
                  mentions: JSON.parse(b.mentions_json || '[]'),
                }))
            }
          />
        </div>

        {/* Center area */}
        <div className="flex-1 overflow-y-auto p-3">
          {/* Error display */}
          {stream.error && (
            <div className="mb-3 p-3 rounded-lg border border-destructive/30 bg-destructive/5 text-xs text-destructive flex items-start gap-2">
              <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" />
              <div>
                <p className="font-medium">Error</p>
                <p className="mt-0.5 text-destructive/80">{stream.error}</p>
              </div>
            </div>
          )}

          {/* Master plan approval card */}
          {stream.pendingMasterPlan && (
            <PlanApprovalCard
              plan={stream.pendingMasterPlan.plan}
              onApprove={(feedback) => stream.respondToMasterPlan(true, feedback)}
              onReject={(feedback) => stream.respondToMasterPlan(false, feedback)}
            />
          )}

          {/* Pre-start info: show session config */}
          {isIdle && !stream.masterState && (
            <div className="space-y-4">
              {/* Session info card */}
              <div className="rounded-lg border p-4 bg-muted/20">
                <h3 className="text-sm font-medium mb-3 flex items-center gap-2">
                  <Users className="h-4 w-4" />
                  Company Configuration
                </h3>

                {/* Projects */}
                <div className="mb-3">
                  <p className="text-[10px] text-muted-foreground uppercase tracking-wide mb-1.5">Projects</p>
                  <div className="flex flex-wrap gap-1.5">
                    {sessionData?.projects.map((p) => (
                      <Badge key={p.project_id} variant="outline" className="text-xs gap-1">
                        <FolderGit2 className="h-3 w-3" />
                        {p.project_name}
                        {p.label && <span className="text-muted-foreground">({p.label})</span>}
                      </Badge>
                    )) ?? <span className="text-xs text-muted-foreground">Loading...</span>}
                  </div>
                </div>

                {/* Roles from config */}
                {config?.role_assignments && config.role_assignments.length > 0 && (
                  <div className="mb-3">
                    <p className="text-[10px] text-muted-foreground uppercase tracking-wide mb-1.5">Configured Roles</p>
                    <div className="space-y-1">
                      {config.role_assignments.map((r: Record<string, string>, idx: number) => (
                        <div key={idx} className="flex items-center gap-2 text-xs">
                          <Bot className="h-3 w-3 text-muted-foreground" />
                          <span className="font-medium capitalize">{r.role}</span>
                          <span className="text-muted-foreground">{r.provider}/{r.model}</span>
                          <Badge variant="outline" className="text-[9px]">{r.tier ?? 'navigate'}</Badge>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* Master config */}
                <div>
                  <p className="text-[10px] text-muted-foreground uppercase tracking-wide mb-1.5">Master Agent</p>
                  <div className="flex items-center gap-2 text-xs">
                    <Crown className="h-3 w-3 text-yellow-400" />
                    <span className="font-medium">master</span>
                    <span className="text-muted-foreground">
                      {config?.master_provider ?? 'anthropic'}/{config?.master_model ?? 'claude-sonnet-4-6'}
                    </span>
                    <Badge variant="outline" className="text-[9px]">full</Badge>
                  </div>
                </div>
              </div>

              <p className="text-xs text-muted-foreground text-center">
                Send a message below to start the Master agent. It will delegate tasks to subordinates.
              </p>
            </div>
          )}

          {/* User message display */}
          {stream.userMessage && (
            <div className="mb-3 p-3 rounded-lg bg-primary/5 border border-primary/20 text-sm">
              <p className="text-[10px] text-muted-foreground mb-1">You</p>
              <p className="whitespace-pre-wrap">{stream.userMessage}</p>
            </div>
          )}

          {/* Master agent pane */}
          {stream.masterState && (
            <div className="mb-3">
              <AgentPane agent={stream.masterState} />
            </div>
          )}

          {/* Subordinate grid */}
          {subordinates.length > 0 && (
            <>
              <p className="text-[10px] text-muted-foreground uppercase tracking-wide mb-2">
                Subordinate Agents ({subordinates.length})
              </p>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                {subordinates.map((agent) => (
                  <AgentPane key={agent.agentRunId} agent={agent} />
                ))}
              </div>
            </>
          )}

          {/* Persisted agent runs (when not streaming) */}
          {!stream.started && sessionData?.agentRuns && sessionData.agentRuns.length > 0 && (
            <>
              <p className="text-[10px] text-muted-foreground uppercase tracking-wide mb-2 mt-4">
                Agent Runs ({sessionData.agentRuns.length})
              </p>
              <div className="space-y-1.5">
                {sessionData.agentRuns.map((run) => (
                  <div key={run.id} className="flex items-center gap-2 text-xs p-2 rounded border">
                    {run.role === 'master'
                      ? <Crown className="h-3 w-3 text-yellow-400" />
                      : <Bot className="h-3 w-3 text-muted-foreground" />
                    }
                    <span className="font-medium capitalize">{run.role}</span>
                    <span className="text-muted-foreground">{run.provider}/{run.model}</span>
                    <Badge variant="outline" className="text-[9px] ml-auto">{run.status}</Badge>
                  </div>
                ))}
              </div>
            </>
          )}

          {/* Loading state */}
          {stream.started && !stream.masterState && !stream.error && (
            <div className="flex items-center justify-center py-8">
              <RefreshCw className="h-5 w-5 animate-spin text-muted-foreground" />
              <span className="ml-2 text-sm text-muted-foreground">Starting Master agent...</span>
            </div>
          )}
        </div>
      </div>

      {/* Composer — bottom */}
      <div className="border-t p-3">
        <div className="flex gap-2">
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={isIdle
              ? 'Describe the task for your AI team...'
              : stream.connected
                ? 'Session is running...'
                : 'Send a follow-up message...'
            }
            disabled={stream.connected}
            className="flex-1 resize-none rounded-md border bg-background px-3 py-2 text-sm min-h-[60px] max-h-[120px] focus:outline-none focus:ring-1 focus:ring-ring disabled:opacity-50"
            rows={2}
          />
          <Button
            onClick={handleSend}
            disabled={!input.trim() || stream.connected}
            size="sm"
            className="self-end h-9"
          >
            <Send className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>
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
  const [feedback, setFeedback] = useState('');

  return (
    <div className="mb-3 rounded-lg border-2 border-yellow-500/40 bg-yellow-500/5 p-4">
      <div className="flex items-center gap-2 mb-2">
        <Crown className="h-4 w-4 text-yellow-400" />
        <span className="text-sm font-medium">Master submitted a plan for your approval</span>
      </div>
      <div className="bg-background rounded-md border p-3 mb-3 text-xs whitespace-pre-wrap max-h-60 overflow-y-auto">
        {plan}
      </div>
      <textarea
        value={feedback}
        onChange={(e) => setFeedback(e.target.value)}
        placeholder="Optional feedback..."
        className="w-full rounded-md border bg-background px-3 py-1.5 text-xs resize-none mb-2"
        rows={2}
      />
      <div className="flex gap-2">
        <Button
          size="sm"
          variant="default"
          onClick={() => onApprove(feedback || undefined)}
          className="gap-1"
        >
          <CheckCircle className="h-3.5 w-3.5" />
          Approve
        </Button>
        <Button
          size="sm"
          variant="outline"
          onClick={() => onReject(feedback || undefined)}
          className="gap-1 text-destructive"
        >
          <XCircle className="h-3.5 w-3.5" />
          Reject
        </Button>
      </div>
    </div>
  );
}
