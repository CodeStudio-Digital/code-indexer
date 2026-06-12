import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Bot, Check, Crown, Folder, GitBranch, Plus, ScrollText, Server, Trash2, Users } from 'lucide-react';
import { Badge } from '../../../components/ui/badge.js';
import { cn } from '../../../lib/utils.js';
import { apiPost } from '../../../hooks/useApi.js';
import { AgentPane } from '../AgentPane.js';
import ServicesSidebar from '../ServicesSidebar.js';
import { ProjectBadge } from './ProjectBadge.js';
import { ProjectRolesBinding } from './ProjectRolesBinding.js';
import { OperationalRulesEditor } from './OperationalRulesEditor.js';
import type { RoleConfig } from '../RoleEditModal.js';
import { SidebarSection } from './SidebarSection.js';
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
  /** Open the role modal: `{ draft }` creates, `{ draft, editIdx }` edits that row. */
  onOpenRoleDialog: (args: { draft: RoleConfig; editIdx?: number }) => void;
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
  onOpenRoleDialog,
}: AgentsSidebarProps) {
  const { t } = useTranslation('agents');
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

  async function removeRole(idx: number) {
    const role = roleAssignments[idx];
    if (!role || role.role === 'master') return;
    const hasLiveAgent = subordinates.some((s) => s.role === role.role);
    const msg = hasLiveAgent
      ? t('role.removeConfirmActive', { role: role.role })
      : t('role.removeConfirm', { role: role.role });
    if (!confirm(msg)) return;
    await patchRoleAssignments(roleAssignments.filter((_, i) => i !== idx));
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
    onOpenRoleDialog({ draft: { role: '', provider: defaultProvider, model: defaultModel, tier: 'navigate' } });
  }

  // Row click opens the FULL editor (tier, system prompt, skills, thinking,
  // fallback) for the existing role. Provider/model hot-swap on a running
  // session moved into RoleDialog's commit (was the inline RoleModelEditor).
  function openEditRoleDialog(idx: number) {
    const r = roleAssignments[idx];
    if (!r) return;
    onOpenRoleDialog({
      draft: { tier: 'navigate', ...(r as unknown as Partial<RoleConfig>), role: r.role ?? '' } as RoleConfig,
      editIdx: idx,
    });
  }

  const availableProjects = (allProjects ?? []).filter(
    (p) => !projects.some((sp) => sp.project_id === p.id),
  );

  return (
    <div
      className={cn(
        // Flex column that fills its parent (the right-rail drawer).
        // Previously had `w-64 border-r` because it lived as a fixed
        // left-rail; now the drawer owns width/borders so we strip
        // those and just let it expand.
        'h-full w-full overflow-y-auto bg-muted/10 flex-col',
        open ? 'flex' : 'hidden',
      )}
    >
      <div className="px-2.5 py-2 border-b flex items-center gap-1.5">
        <Bot className="h-3.5 w-3.5 text-muted-foreground" />
        <span className="text-xs font-medium">{t('company.config')}</span>
      </div>

      {/* ── Projetos ── */}
      <SidebarSection
        storageKey="projects"
        icon={Folder}
        title={t('company.projects')}
        count={projects.length}
        action={
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
        }
      >
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
      </SidebarSection>

      {/* ── Agentes por projeto (bindings) ── */}
      {hasProjects && hasRoles && (
        <SidebarSection
          storageKey="projectRoles"
          icon={GitBranch}
          title={t('company.projectRoles', 'Agentes por projeto')}
        >
          <ProjectRolesBinding
            projects={projects}
            roleAssignments={roleAssignments}
            onUpdate={patchRoleAssignments}
            embedded
          />
        </SidebarSection>
      )}

      {/* ── Papéis Configurados (editable provider/model) ── */}
      {hasRoles && (
        <SidebarSection
          storageKey="configuredRoles"
          icon={Users}
          title={t('company.configuredRoles')}
          count={roleAssignments.length}
          action={
            <button
              type="button"
              onClick={openNewRoleDialog}
              className="text-muted-foreground hover:text-foreground transition-colors"
              title={t('company.addRole')}
            >
              <Plus className="h-3 w-3" />
            </button>
          }
        >
          <div className="space-y-1">
            {roleAssignments.map((r, i) => (
              <div key={i} className="rounded border p-1.5 space-y-1">
                <div
                  className="flex items-center gap-2 text-[10px] cursor-pointer hover:bg-muted/50 rounded px-1 py-0.5"
                  onClick={() => openEditRoleDialog(i)}
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
                  {r.role !== 'master' && (
                    <button
                      type="button"
                      title={t('role.remove', 'Remover papel')}
                      onClick={(e) => {
                        e.stopPropagation();
                        void removeRole(i);
                      }}
                      className="text-muted-foreground hover:text-destructive transition-colors shrink-0"
                    >
                      <Trash2 className="h-3 w-3" />
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        </SidebarSection>
      )}

      {/* ── Regras Operacionais (política da sessão, injetada em todo agente) ── */}
      <SidebarSection
        storageKey="operationalRules"
        icon={ScrollText}
        title={t('company.operationalRules.label')}
        defaultOpen={false}
      >
        <OperationalRulesEditor
          sessionId={sessionId}
          value={(config?.operational_rules as string | undefined) ?? ''}
          refetch={refetch}
        />
      </SidebarSection>

      {/* ── Microservices — only when the session can actually have them:
          builder mode (sandbox network) or services already attached
          (session projects with a label). Permanent "No services yet"
          noise in plain sessions helped nobody. ── */}
      {(!!config?.builder || projects.some((p) => !!p.label)) && (
        <SidebarSection
          storageKey="microservices"
          icon={Server}
          title="Microservices"
        >
          <ServicesSidebar sessionId={sessionId} embedded />
        </SidebarSection>
      )}

      {/* ── Agentes (live state) ── */}
      {/*
        Footer "Papéis do Template" list was REMOVED as duplicate of
        "Papéis Configurados" above. The persistedAgentRuns fallback
        was ALSO removed (rendered when !stream.started) — the live
        stream subscription (masterState + subordinates) is the single
        source of truth, no double-list. When the stream isn't started
        yet, the empty-state message handles it.
      */}
      <SidebarSection
        storageKey="agents"
        icon={Bot}
        title={t('company.agentsLabel')}
        count={(stream.masterState ? 1 : 0) + subordinates.length}
      >
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
            onPause={() => void stream.pauseAgent(agent.agentRunId)}
            onResume={() => void stream.resumeAgent(agent.agentRunId)}
            onDelete={() => {
              if (confirm(t('agentActions.deleteConfirm', { role: agent.role }))) {
                void stream.deleteAgent(agent.agentRunId);
              }
            }}
          />
        ))}

        {!stream.masterState && !subordinates.length && (
          <p className="text-[10px] text-muted-foreground text-center py-3">
            {t('company.noAgents')}
          </p>
        )}
      </SidebarSection>
    </div>
  );
}
