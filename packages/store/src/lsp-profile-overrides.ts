import type { DB } from './db/types.js';

export interface ProjectLspProfileOverride {
  projectId: number;
  familyId: string;
  workspacePath: string;
  profileId: string;
  updatedAt: string;
}

interface OverrideRow {
  project_id: number;
  family_id: string;
  workspace_path: string;
  profile_id: string;
  updated_at: string;
}

function mapRow(row: OverrideRow): ProjectLspProfileOverride {
  return {
    projectId: row.project_id,
    familyId: row.family_id,
    workspacePath: row.workspace_path,
    profileId: row.profile_id,
    updatedAt: row.updated_at,
  };
}

export function listProjectLspProfileOverrides(
  db: DB,
  projectId: number,
  familyId: string,
): ProjectLspProfileOverride[] {
  return (db.prepare(`
    SELECT project_id, family_id, workspace_path, profile_id, updated_at
    FROM project_lsp_profile_overrides
    WHERE project_id = ? AND family_id = ?
    ORDER BY workspace_path
  `).all(projectId, familyId) as OverrideRow[]).map(mapRow);
}

export function setProjectLspProfileOverride(
  db: DB,
  input: Omit<ProjectLspProfileOverride, 'updatedAt'>,
): void {
  db.prepare(`
    INSERT INTO project_lsp_profile_overrides
      (project_id, family_id, workspace_path, profile_id, updated_at)
    VALUES (?, ?, ?, ?, datetime('now'))
    ON CONFLICT(project_id, family_id, workspace_path) DO UPDATE SET
      profile_id = excluded.profile_id,
      updated_at = excluded.updated_at
  `).run(input.projectId, input.familyId, input.workspacePath, input.profileId);
}

export function removeProjectLspProfileOverride(
  db: DB,
  projectId: number,
  familyId: string,
  workspacePath: string,
): void {
  db.prepare(`
    DELETE FROM project_lsp_profile_overrides
    WHERE project_id = ? AND family_id = ? AND workspace_path = ?
  `).run(projectId, familyId, workspacePath);
}
