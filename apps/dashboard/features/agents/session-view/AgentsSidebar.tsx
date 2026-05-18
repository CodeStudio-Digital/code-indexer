import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Bot, Check, Crown, Plus } from 'lucide-react';
import { Badge } from '../../../components/ui/badge.js';
import { cn } from '../../../lib/utils.js';
import { apiPost } from '../../../hooks/useApi.js';
import { AgentPane } from '../AgentPane.js';
import ServicesSidebar from '../ServicesSidebar.js';
import { ProjectBadge } from './ProjectBadge.js';
import { ProjectRolesBinding } from './ProjectRolesBinding.js';
import { RoleModelEditor } from './RoleModelEditor.js';
import type { useCompanyStream } from '../../../hooks/useCompanyStream.js';
import type { AgentStreamState } from '../../../state/company/types.js';
import type {
  AvailableProject,
  PersistedAgentRun,
  RoleAssignmentRaw,
  SessionProject,
} from './types.js';

interface ProviderOption {
  id: string;
  label: string;
}

interface AgentsSidebarProps {
  sessionId: number;
  open: boolean;
  config: Record<string, unknown> | null;
  projects: SessionProject[];
  allProjects: AvailableProject[] | null;
  persistedAgentRuns: PersistedAgentRun[];
  subordinates: AgentStreamState[];
  stream: ReturnType<typeof useCompanyStream>;
  providerOptions: ProviderOption[];
  getModelsForProvider: (provider: string) => Array<{ id: string; name: string; mode?: string }>;
  getDefaultModel: (provider: string) => string;
  refetch: () => void;
  onOpenAgentRun: (agentRunId: number, role: string, status: string) => void;
  onOpenPersistedRun: (coderSessionId: number, role: string, status: string) => void;
  onOpenNewRoleDialog: (defaults: { provider: string; model: string }) => void;
}

/**
 * Left-hand "config + agents" rail of `CompanySessionView`. Owns the
 * editing widgets (project list with add/remove, project↔roles binding,
 * inline role provider/model edit) and renders running + persisted
 * agents below.
 *
 * Local UI state (which role row is being edited, the "add project"
 * inline form) lives here. Modal opens (new-role wizard, agent session
 * details) bubble up via callbacks so the modal stack stays mounted at
 * the top of the view.
 */
export function AgentsSidebar({
  sessionId,
  open,
  config,
  projects,
  allProjects,
  persistedAgentRuns,
  subordinates,
  stream,
  providerOptions,
  getModelsForProvider,
  getDefaultModel,
  refetch,
  onOpenAgentRun,
  onOpenPersistedRun,
  onOpenNewRoleDialog,
}: AgentsSidebarProps) {
  const { t } = useTranslation('agents');
  const [editingRoleIdx, setEditingRoleIdx] = useState<number | null>(null);
  const [addingProject, setAddingProject] = useState(false);
  const [newProjectId, setNewProjectId] = useState('');

  const roleAssignments = (config?.role_assignments as RoleAssignmentRaw[] | undefined) ?? [];
  const hasRoles = roleAssignments.length > 0;
  const hasProjects = projects.length > 0;

  async function patchRoleAssignments(updated: RoleAssignmentRaw[]) {
    try {
      await fetch(`/api/company/sessions/${sessionId}/config`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ role_assignments: updated }),
      });
    } catch {
      /* non-fatal — refetch reconciles */
    }
    refetch();
  }

  async function deleteProject(p: SessionProject) {
    const isService = !!p.label;
    const confirmMsg = isService
      ? `Remover microserviço '${p.label}'? O container e os arquivos serão destruídos.`
      : `Desvincular '${p.project_name}' desta sessão? O projeto continua disponível em outras sessões.`;
    if (!confirm(confirmMsg)) return;
    const r = await fetch(`/api/company/sessions/${sessionId}/projects/${p.project_id}`, {
      method: 'DELETE',
    });
    if (!r.ok) {
      const body = (await r.json().catch(() => ({}))) as { error?: string };
      alert(body.error ?? `HTTP ${r.status}`);
      return;
    }
    refetch();
  }

  async function addProject() {
    if (!newProjectId) return;
    await apiPost(`/company/sessions/${sessionId}/projects`, { project_id: Number(newProjectId) });
    setNewProjectId('');
    setAddingProject(false);
    refetch();
  }

  function openNewRoleDialog() {
    const pool = (config?.allowed_models as Array<{ provider: string; model: string; is_default?: boolean }> | undefined) ?? [];
    const poolPick = pool.find((e) => e.is_default) ?? pool[0] ?? null;
    const masterRow = roleAssignments.find((x) => x.role === 'master');
    const defaultProvider = poolPick?.provider ?? masterRow?.provider ?? providerOptions[0]?.id ?? 'anthropic';
    const defaultModel = poolPick?.model ?? masterRow?.model ?? getDefaultModel(defaultProvider);
    onOpenNewRoleDialog({ provider: defaultProvider, model: defaultModel });
  }

  async function applyRoleProviderChange(idx: number, provider: string, model: string) {
    const updated = roleAssignments.map((role, i) => (i === idx ? { ...role, provider, model } : role));
    const isMaster = roleAssignments[idx]?.role === 'master';
    const masterRow = roleAssignments.find((x) => x.role === 'master');
    await stream.switchProvider(
      isMaster ? provider : (config?.master_provider as string | undefined) ?? masterRow?.provider ?? provider,
      isMaster ? model : (config?.master_model as string | undefined) ?? masterRow?.model,
      updated as Array<{ role: string; provider: string; model: string; tier: string }>,
    );
    try {
      await fetch(`/api/company/sessions/${sessionId}/config`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ role_assignments: updated }),
      });
    } catch {
      /* live swap above already happened — refetch keeps UI in sync */
    }
    setEditingRoleIdx(null);
    refetch();
  }

  const availableProjects = (allProjects ?? []).filter(
    (p) => !projects.some((sp) => sp.project_id === p.id),
  );

  return (
    <div
      className={cn(
        'w-64 border-r flex-shrink-0 overflow-y-auto bg-muted/10 flex-col',
        open ? 'flex' : 'hidden',
      )}
    >
      <div className="px-2.5 py-2 border-b flex items-center gap-1.5">
        <Bot className="h-3.5 w-3.5 text-muted-foreground" />
        <span className="text-xs font-medium">{t('company.config')}</span>
      </div>

      <div className="p-2 space-y-2">
        {/* Projects */}
        <div>
          <div className="flex items-center justify-between mb-1.5">
            <p className="text-[10px] text-muted-foreground uppercase tracking-wide">
              {t('company.projects')}
            </p>
            <button
              type="button"
              onClick={() => {
                setAddingProject((v) => !v);
                setNewProjectId('');
              }}
              className="text-muted-foreground hover:text-foreground transition-colors"
              title="Add project"
            >
              <Plus className="h-3 w-3" />
            </button>
          </div>
          <div className="flex flex-wrap gap-1.5">
            {projects.map((p) => (
              <ProjectBadge
                key={p.project_id}
                projectId={p.project_id}
                name={p.project_name}
                label={p.label}
                onRenamed={refetch}
                canDelete={projects.length > 1}
                onDelete={() => deleteProject(p)}
              />
            ))}
          </div>
          {addingProject && (
            availableProjects.length > 0 ? (
              <div className="flex gap-1 mt-1.5">
                <select
                  value={newProjectId}
                  onChange={(e) => setNewProjectId(e.target.value)}
                  className="flex-1 rounded border bg-background px-1 py-0.5 text-[10px]"
                >
                  <option value="">Select...</option>
                  {availableProjects.map((p) => (
                    <option key={p.id} value={String(p.id)}>{p.name}</option>
                  ))}
                </select>
                <button
                  type="button"
                  disabled={!newProjectId}
                  className="disabled:opacity-40 text-muted-foreground hover:text-foreground transition-colors"
                  onClick={() => void addProject()}
                >
                  <Check className="h-3 w-3" />
                </button>
              </div>
            ) : (
              <p className="text-[10px] text-muted-foreground mt-1">
                {t('company.noMoreProjects', 'No more projects available')}
              </p>
            )
          )}
        </div>

        {/* Agents per project */}
        {hasProjects && hasRoles && (
          <ProjectRolesBinding
            projects={projects}
            roleAssignments={roleAssignments}
            onUpdate={patchRoleAssignments}
          />
        )}

        {/* Roles — editable provider/model */}
        {hasRoles && (
          <div>
            <div className="flex items-center justify-between mb-1.5">
              <p className="text-[10px] text-muted-foreground uppercase tracking-wide">
                {t('company.configuredRoles')}
              </p>
              <button
                type="button"
                onClick={openNewRoleDialog}
                className="text-muted-foreground hover:text-foreground transition-colors"
                title={t('company.addRole')}
              >
                <Plus className="h-3 w-3" />
              </button>
            </div>
            <div className="space-y-1">
              {roleAssignments.map((r, i) => (
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
                    <span className="text-muted-foreground text-[9px] truncate max-w-[100px]">
                      {r.provider}/{r.model}
                    </span>
                    {r.tier && (
                      <Badge variant="outline" className="text-[9px] px-1">
                        {r.tier}
                      </Badge>
                    )}
                  </div>
                  {editingRoleIdx === i && (
                    <RoleModelEditor
                      role={r as unknown as Record<string, string>}
                      providerOptions={providerOptions}
                      getModelsForProvider={getModelsForProvider}
                      getDefaultModel={getDefaultModel}
                      onApply={(provider, model) => void applyRoleProviderChange(i, provider, model)}
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
        <span className="text-xs font-medium">{t('company.agentsLabel')}</span>
        <Badge variant="outline" className="text-[9px] ml-auto">
          {(stream.masterState ? 1 : 0) + subordinates.length}
        </Badge>
      </div>

      <div className="p-2 space-y-2">
        {stream.masterState && (
          <AgentPane
            agent={stream.masterState}
            onClick={() => {
              const masterRun = persistedAgentRuns.find((r) => r.role === 'master');
              if (masterRun) onOpenAgentRun(masterRun.id, 'master', stream.masterState!.status);
            }}
          />
        )}

        {subordinates.map((agent) => (
          <AgentPane
            key={agent.agentRunId}
            agent={agent}
            onClick={() => onOpenAgentRun(agent.agentRunId, agent.role, agent.status)}
          />
        ))}

        {!stream.started && persistedAgentRuns.map((run) => (
          <div
            key={run.id}
            role="button"
            tabIndex={0}
            onClick={() => onOpenPersistedRun(run.coder_session_id, run.role, run.status)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') onOpenPersistedRun(run.coder_session_id, run.role, run.status);
            }}
            className="flex items-center gap-1.5 text-[10px] p-2 rounded border cursor-pointer hover:bg-muted/50"
          >
            {run.role === 'master' ? (
              <Crown className="h-3 w-3 text-yellow-400" />
            ) : (
              <Bot className="h-3 w-3 text-muted-foreground" />
            )}
            <span className="font-medium capitalize truncate">{run.role}</span>
            <Badge variant="outline" className="text-[8px] ml-auto capitalize">
              {run.status}
            </Badge>
          </div>
        ))}

        {!stream.masterState && !subordinates.length && persistedAgentRuns.length === 0 && (
          <p className="text-[10px] text-muted-foreground text-center py-3">
            {t('company.noAgents')}
          </p>
        )}

        {hasRoles && (
          <div className="border-t pt-2 mt-2">
            <p className="text-[9px] text-muted-foreground uppercase tracking-wide mb-1">
              {t('company.templateRoles')}
            </p>
            {roleAssignments.map((r, i) => (
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
  );
}
