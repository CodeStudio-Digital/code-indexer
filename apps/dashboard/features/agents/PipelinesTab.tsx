import React, { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Network, Pause, Play, Plus, RefreshCw, Square, Trash2 } from 'lucide-react';
import { Badge } from '../../components/ui/badge.js';
import { Button } from '../../components/ui/button.js';
import { Textarea } from '../../components/ui/textarea.js';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../../components/ui/tabs.js';
import { useApi, apiPost, apiDelete } from '../../hooks/useApi.js';
import { confirm } from '../../components/ui/prompt-dialog.js';
import { PipelineBuilder } from './pipelines/PipelineBuilder.js';
import type {
  Pipeline,
  PipelineExecution,
  PipelineNodeExecution,
} from '@mcp/company/types.js';

interface PipelinesTabProps {
  companySessionId: number;
}

interface SessionFullData {
  agentRuns: Array<{ role: string }>;
  session: { config_json: string };
}

interface SkillsResponse {
  skills: Array<{ id: string; name: string; enabled: boolean }>;
}

type PipelinesResponse = Pipeline[] | { pipelines?: Pipeline[]; error?: string };
type PipelineExecutionsResponse = PipelineExecution[] | { executions?: PipelineExecution[]; error?: string };

function normalizePipelines(data: PipelinesResponse | null): Pipeline[] {
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.pipelines)) return data.pipelines;
  return [];
}

function normalizeExecutions(data: PipelineExecutionsResponse | null): PipelineExecution[] {
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.executions)) return data.executions;
  return [];
}

function responseError(data: PipelinesResponse | PipelineExecutionsResponse | null): string | null {
  if (data && !Array.isArray(data) && typeof data.error === 'string') return data.error;
  return null;
}

/**
 * V1 of the Pipelines tab. Lists pipelines visible to the session, lets
 * the operator open a visual drag-drop builder (`PipelineBuilder`),
 * and surfaces executions in a side panel with pause / resume / abort
 * controls.
 *
 * Polling on the executions list and the active execution detail keeps
 * the timeline fresh without subscribing to the metaBus directly — the
 * SSE wiring lands in V2 alongside inbox events.
 */
export function PipelinesTab({ companySessionId }: PipelinesTabProps) {
  const { t } = useTranslation(['agents', 'common']);

  const pipelinesApi = useApi<PipelinesResponse>(`/company/pipelines?company_session_id=${companySessionId}`);
  const executionsApi = useApi<PipelineExecutionsResponse>(
    `/company/sessions/${companySessionId}/pipelines/executions`,
  );
  const sessionApi = useApi<SessionFullData>(`/company/sessions/${companySessionId}`);
  const skillsApi = useApi<SkillsResponse>('/admin/skills');

  const [editing, setEditing] = useState<Pipeline | null | undefined>(undefined);
  const [selectedExecutionId, setSelectedExecutionId] = useState<number | null>(null);
  const pipelines = useMemo(() => normalizePipelines(pipelinesApi.data), [pipelinesApi.data]);
  const pipelineListError = responseError(pipelinesApi.data);
  const executions = useMemo(() => normalizeExecutions(executionsApi.data), [executionsApi.data]);
  const executionListError = responseError(executionsApi.data);

  // Refetch executions every 4s so progress updates land without SSE.
  useEffect(() => {
    const t = setInterval(() => executionsApi.refetch(), 4000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const availableRoles = useMemo(() => {
    const fromConfig: string[] = [];
    if (sessionApi.data?.session?.config_json) {
      try {
        const cfg = JSON.parse(sessionApi.data.session.config_json) as {
          role_assignments?: Array<{ role: string }>;
        };
        for (const r of cfg.role_assignments ?? []) fromConfig.push(r.role);
      } catch { /* ignore */ }
    }
    const fromRuns = (sessionApi.data?.agentRuns ?? []).map((r) => r.role);
    const set = new Set([...fromConfig, ...fromRuns]);
    set.delete('master');
    return Array.from(set).sort();
  }, [sessionApi.data]);

  const availableSkills = useMemo(
    () => (skillsApi.data?.skills ?? []).filter((s) => s.enabled).map((s) => s.id),
    [skillsApi.data],
  );

  if (editing !== undefined) {
    return (
      <PipelineBuilder
        scope={{ kind: 'company', companySessionId }}
        pipeline={editing}
        availableRoles={availableRoles}
        availableSkills={availableSkills}
        onClose={() => setEditing(undefined)}
        onSaved={() => {
          setEditing(undefined);
          pipelinesApi.refetch();
        }}
      />
    );
  }

  return (
    <div className="flex h-full flex-col">
      <Tabs defaultValue="list" className="flex flex-1 flex-col overflow-hidden">
        <TabsList className="mx-3 mt-2 w-fit">
          <TabsTrigger value="list" className="gap-1 text-xs">
            <Network className="h-3 w-3" /> {t('agents:pipelines.listTab')}
          </TabsTrigger>
          <TabsTrigger value="executions" className="gap-1 text-xs">
            <Play className="h-3 w-3" /> {t('agents:pipelines.executionsTab')}
          </TabsTrigger>
        </TabsList>

        <TabsContent value="list" className="mt-0 flex-1 overflow-auto">
          <div className="flex items-center justify-between border-b px-3 py-2">
            <div className="text-xs text-muted-foreground">
              {pipelines.length} {t('agents:pipelines.pipelinesAvailable')}
            </div>
            <div className="flex gap-2">
              <Button size="sm" variant="ghost" onClick={() => pipelinesApi.refetch()}>
                <RefreshCw className="h-3.5 w-3.5" />
              </Button>
              <Button size="sm" onClick={() => setEditing(null)}>
                <Plus className="h-3.5 w-3.5 mr-1" /> {t('agents:pipelines.create')}
              </Button>
            </div>
          </div>

          {pipelineListError && (
            <div className="mx-3 mt-3 rounded border border-destructive/40 bg-destructive/10 p-2 text-xs">
              {pipelineListError}
            </div>
          )}

          {pipelines.length === 0 && !pipelineListError && (
            <div className="px-6 py-12 text-center text-sm text-muted-foreground">
              {t('agents:pipelines.empty')}
            </div>
          )}

          <ul className="divide-y">
            {pipelines.map((p) => (
              <PipelineRow
                key={p.id}
                pipeline={p}
                companySessionId={companySessionId}
                onEdit={() => setEditing(p)}
                onDeleted={() => pipelinesApi.refetch()}
                onStarted={(execId) => {
                  executionsApi.refetch();
                  setSelectedExecutionId(execId);
                }}
              />
            ))}
          </ul>
        </TabsContent>

        <TabsContent value="executions" className="mt-0 flex-1 overflow-hidden">
          <div className="flex h-full">
            <div className="w-72 border-r overflow-auto">
              <div className="border-b px-3 py-2 flex items-center justify-between">
                <div className="text-xs text-muted-foreground">
                  {executions.length} {t('agents:pipelines.runs')}
                </div>
                <Button size="sm" variant="ghost" onClick={() => executionsApi.refetch()}>
                  <RefreshCw className="h-3.5 w-3.5" />
                </Button>
              </div>
              {executionListError && (
                <div className="mx-3 mt-3 rounded border border-destructive/40 bg-destructive/10 p-2 text-xs">
                  {executionListError}
                </div>
              )}
              <ul className="divide-y">
                {executions.map((ex) => (
                  <li
                    key={ex.id}
                    onClick={() => setSelectedExecutionId(ex.id)}
                    className={`cursor-pointer px-3 py-2 text-xs hover:bg-accent ${
                      selectedExecutionId === ex.id ? 'bg-accent' : ''
                    }`}
                  >
                    <div className="flex items-center justify-between">
                      <span className="font-medium">#{ex.id}</span>
                      <ExecutionStatusBadge status={ex.status} />
                    </div>
                    <div className="text-muted-foreground">{ex.started_at}</div>
                  </li>
                ))}
              </ul>
            </div>
            <div className="flex-1 overflow-auto">
              {selectedExecutionId ? (
                <ExecutionDetail
                  companySessionId={companySessionId}
                  executionId={selectedExecutionId}
                  onChanged={() => executionsApi.refetch()}
                />
              ) : (
                <div className="px-6 py-12 text-center text-sm text-muted-foreground">
                  {t('agents:pipelines.selectExecution')}
                </div>
              )}
            </div>
          </div>
        </TabsContent>
      </Tabs>
    </div>
  );
}

function PipelineRow({
  pipeline,
  companySessionId,
  onEdit,
  onDeleted,
  onStarted,
}: {
  pipeline: Pipeline;
  companySessionId: number;
  onEdit: () => void;
  onDeleted: () => void;
  onStarted: (executionId: number) => void;
}) {
  const { t } = useTranslation(['agents', 'common']);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showStart, setShowStart] = useState(false);
  const [initialInput, setInitialInput] = useState('');

  const handleStart = async () => {
    setStarting(true);
    setError(null);
    try {
      const exec = await apiPost<PipelineExecution>(
        `/company/sessions/${companySessionId}/pipelines/${pipeline.id}/start`,
        { initial_input: initialInput },
      );
      onStarted(exec.id);
      setShowStart(false);
      setInitialInput('');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setStarting(false);
    }
  };

  const handleDelete = async () => {
    const ok = await confirm({
      title: t('agents:pipelines.confirmDelete', { name: pipeline.name }),
      confirmLabel: t('common:delete', { defaultValue: 'Delete' }),
      tone: 'destructive',
    });
    if (!ok) return;
    await apiDelete(`/company/pipelines/${pipeline.id}`);
    onDeleted();
  };

  return (
    <li className="px-3 py-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="font-medium text-sm">{pipeline.name}</span>
            <Badge variant="secondary" className="text-[10px]">v{pipeline.version}</Badge>
            <Badge variant="outline" className="text-[10px]">
              {pipeline.company_session_id == null
                ? t('agents:pipelines.scope.global')
                : t('agents:pipelines.scope.session')}
            </Badge>
          </div>
          {pipeline.description && (
            <div className="text-xs text-muted-foreground mt-0.5">{pipeline.description}</div>
          )}
          <div className="text-[11px] text-muted-foreground mt-1">
            {pipeline.graph.nodes.length} {t('agents:pipelines.nodes')} ·{' '}
            {pipeline.graph.edges.length} {t('agents:pipelines.edges')}
          </div>
        </div>
        <div className="flex shrink-0 gap-1">
          <Button size="sm" variant="ghost" onClick={onEdit}>
            {t('common:actions.edit')}
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setShowStart((v) => !v)}>
            <Play className="h-3.5 w-3.5 mr-1" /> {t('agents:pipelines.run')}
          </Button>
          <Button size="sm" variant="ghost" onClick={handleDelete}>
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>

      {showStart && (
        <div className="mt-2 rounded border bg-muted/50 p-2">
          <Textarea
            value={initialInput}
            onChange={(e) => setInitialInput(e.target.value)}
            placeholder={t('agents:pipelines.initialInputPlaceholder')}
            rows={3}
            className="text-xs"
          />
          {error && <div className="mt-1 text-xs text-destructive">{error}</div>}
          <div className="mt-2 flex justify-end gap-2">
            <Button size="sm" variant="ghost" onClick={() => setShowStart(false)}>
              {t('common:actions.cancel')}
            </Button>
            <Button size="sm" disabled={starting || !initialInput.trim()} onClick={handleStart}>
              {starting ? t('common:actions.loading') : t('agents:pipelines.start')}
            </Button>
          </div>
        </div>
      )}
    </li>
  );
}

function ExecutionDetail({
  companySessionId,
  executionId,
  onChanged,
}: {
  companySessionId: number;
  executionId: number;
  onChanged: () => void;
}) {
  const { t } = useTranslation(['agents', 'common']);
  const detail = useApi<{ execution: PipelineExecution; nodes: PipelineNodeExecution[] }>(
    `/company/sessions/${companySessionId}/pipelines/executions/${executionId}`,
  );

  // Poll only while live — pause/complete/failed/aborted are terminal
  // for the dashboard view (resume re-launches and creates new rows).
  useEffect(() => {
    const live = detail.data?.execution.status === 'running';
    if (!live) return;
    const t = setInterval(() => detail.refetch(), 3000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [detail.data?.execution.status]);

  const handleAbort = async () => {
    await apiPost(
      `/company/sessions/${companySessionId}/pipelines/executions/${executionId}/abort`,
      { reason: 'aborted from dashboard' },
    );
    detail.refetch();
    onChanged();
  };

  const handlePause = async () => {
    await apiPost(
      `/company/sessions/${companySessionId}/pipelines/executions/${executionId}/pause`,
      {},
    );
    detail.refetch();
    onChanged();
  };

  const handleResume = async () => {
    await apiPost(
      `/company/sessions/${companySessionId}/pipelines/executions/${executionId}/resume`,
      {},
    );
    detail.refetch();
    onChanged();
  };

  if (!detail.data) {
    return <div className="px-6 py-12 text-center text-sm text-muted-foreground">{t('common:actions.loading')}</div>;
  }

  const { execution, nodes } = detail.data;
  return (
    <div className="p-4">
      <div className="flex items-center justify-between mb-3">
        <div>
          <div className="text-xs text-muted-foreground">{t('agents:pipelines.executionId')}</div>
          <div className="font-medium">#{execution.id}</div>
        </div>
        <div className="flex items-center gap-2">
          <ExecutionStatusBadge status={execution.status} />
          {execution.status === 'running' && (
            <>
              <Button size="sm" variant="outline" onClick={handlePause}>
                <Pause className="h-3 w-3 mr-1" /> {t('agents:pipelines.pause')}
              </Button>
              <Button size="sm" variant="destructive" onClick={handleAbort}>
                <Square className="h-3 w-3 mr-1" /> {t('agents:pipelines.abort')}
              </Button>
            </>
          )}
          {execution.status === 'paused' && (
            <Button size="sm" onClick={handleResume}>
              <Play className="h-3 w-3 mr-1" /> {t('agents:pipelines.resume')}
            </Button>
          )}
        </div>
      </div>

      {execution.error_message && (
        <div className="mb-3 rounded border border-destructive/40 bg-destructive/10 p-2 text-xs">
          {execution.error_message}
        </div>
      )}

      <ol className="space-y-2">
        {nodes.map((n) => (
          <li key={n.id} className="rounded border p-2 text-xs">
            <div className="flex items-center justify-between gap-2">
              <div>
                <span className="font-medium">{n.node_label}</span>
                <span className="text-muted-foreground ml-2">@{n.role}</span>
                {n.attempt > 1 && (
                  <Badge variant="outline" className="ml-2 text-[10px]">
                    {t('agents:pipelines.attempt', { n: n.attempt })}
                  </Badge>
                )}
              </div>
              <div className="flex items-center gap-1">
                {n.outcome_branch && (
                  <Badge variant="outline" className="text-[10px]">{n.outcome_branch}</Badge>
                )}
                <NodeStatusBadge status={n.status} />
              </div>
            </div>
            {n.kanban_card_id && (
              <div className="text-muted-foreground mt-1">
                {t('agents:pipelines.cardId', { id: n.kanban_card_id })}
              </div>
            )}
            {n.output_text && (
              <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap rounded bg-muted p-2 font-mono text-[11px]">
                {n.output_text}
              </pre>
            )}
            {n.error_message && (
              <div className="mt-1 text-destructive">{n.error_message}</div>
            )}
          </li>
        ))}
        {nodes.length === 0 && (
          <li className="text-center text-xs text-muted-foreground py-4">
            {t('agents:pipelines.noNodesYet')}
          </li>
        )}
      </ol>
    </div>
  );
}

function ExecutionStatusBadge({ status }: { status: PipelineExecution['status'] }) {
  const variants: Record<PipelineExecution['status'], 'default' | 'secondary' | 'destructive' | 'outline'> = {
    running: 'default',
    paused: 'secondary',
    completed: 'secondary',
    failed: 'destructive',
    aborted: 'outline',
  };
  return <Badge variant={variants[status]} className="text-[10px]">{status}</Badge>;
}

function NodeStatusBadge({ status }: { status: PipelineNodeExecution['status'] }) {
  const variants: Record<PipelineNodeExecution['status'], 'default' | 'secondary' | 'destructive' | 'outline'> = {
    pending: 'outline',
    running: 'default',
    completed: 'secondary',
    failed: 'destructive',
    skipped: 'outline',
    aborted: 'outline',
  };
  return <Badge variant={variants[status]} className="text-[10px]">{status}</Badge>;
}
