import { useTranslation } from 'react-i18next';
import { FolderGit2, X } from 'lucide-react';
import { AddRoleToProjectMenu } from './AddRoleToProjectMenu.js';
import type { RoleAssignmentRaw, SessionProject } from './types.js';

interface ProjectRolesBindingProps {
  projects: Array<Pick<SessionProject, 'project_id' | 'project_name' | 'label'>>;
  roleAssignments: RoleAssignmentRaw[];
  onUpdate: (updated: RoleAssignmentRaw[]) => void | Promise<void>;
}

/**
 * "Agents per project" panel. Pivots the role_assignments array (where
 * the binding lives as `role.projectIds`) into a project-first view so
 * the operator thinks "who works on this project?" instead of "which
 * projects does this role touch?". The master's prompt mirrors this
 * view, and `spawn_subordinate_agent` enforces the binding.
 */
export function ProjectRolesBinding({ projects, roleAssignments, onUpdate }: ProjectRolesBindingProps) {
  const { t } = useTranslation('agents');
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
        {t('projectAgents.title', 'Agents per project')}
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
                    {t('projectAgents.noRoles', 'No roles bound')}
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
                      title={t('projectAgents.removeRole', 'Unbind')}
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
