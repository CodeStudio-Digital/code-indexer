import { isAbsolute } from 'node:path';
import { ApiError, type AngularProfileOverrideInfo } from '@mcp/api-bus';
import type { CodeIndexDB } from '@mcp/store/db.js';
import {
  listProjectLspProfileOverrides,
  removeProjectLspProfileOverride,
  setProjectLspProfileOverride,
} from '@mcp/store/lsp-profile-overrides.js';
import { invalidateAngularWorkspaceIndex } from '@mcp/services/lsp/angular-workspace-index.js';
import { lspServersForFamily } from '@mcp/services/lsp/server-registry.js';

export const ANGULAR_LSP_FAMILY_ID = 'angular-language-server';

interface CachedOverrides {
  rows: AngularProfileOverrideInfo[];
  versions: Readonly<Record<string, string>>;
}

const cache = new WeakMap<CodeIndexDB, Map<number, CachedOverrides>>();

function normalizeWorkspacePath(raw: string): string {
  const value = raw.trim().replace(/\\/g, '/').replace(/^\.\//, '') || '.';
  if (isAbsolute(value) || /^[A-Za-z]:\//.test(value) || value.includes('\0')) {
    throw new ApiError('bad_input', 400, 'workspacePath must be project-relative');
  }
  const segments = value.split('/').filter((segment) => segment && segment !== '.');
  if (segments.some((segment) => segment === '..')) {
    throw new ApiError('bad_input', 400, 'workspacePath cannot leave the project');
  }
  return segments.join('/') || '.';
}

function majorForProfile(profileId: string): number | null {
  const match = /^angular-(\d+)$/.exec(profileId);
  return match ? Number(match[1]) : null;
}

function readOverrides(db: CodeIndexDB, projectId: number): CachedOverrides {
  let byProject = cache.get(db);
  if (!byProject) { byProject = new Map(); cache.set(db, byProject); }
  const cached = byProject.get(projectId);
  if (cached) return cached;
  const rows = listProjectLspProfileOverrides(
    db.projectScopedDb(projectId),
    projectId,
    ANGULAR_LSP_FAMILY_ID,
  ).map(({ workspacePath, profileId }) => ({ workspacePath, profileId }));
  const versions = Object.fromEntries(rows.flatMap((row) => {
    const major = majorForProfile(row.profileId);
    return major == null ? [] : [[row.workspacePath, `${major}.x`]];
  }));
  const value = { rows, versions };
  byProject.set(projectId, value);
  return value;
}

export function angularVersionOverrides(
  db: CodeIndexDB,
  projectId: number,
): Readonly<Record<string, string>> {
  return readOverrides(db, projectId).versions;
}

export function listAngularProfileOverrides(
  db: CodeIndexDB,
  projectId: number,
): AngularProfileOverrideInfo[] {
  return [...readOverrides(db, projectId).rows];
}

export function writeAngularProfileOverride(
  db: CodeIndexDB,
  projectId: number,
  projectRoot: string,
  workspacePath: string,
  profileId: string | null,
): void {
  const normalized = normalizeWorkspacePath(workspacePath);
  const routed = db.projectScopedDb(projectId);
  if (profileId === null) {
    removeProjectLspProfileOverride(routed, projectId, ANGULAR_LSP_FAMILY_ID, normalized);
  } else {
    const valid = lspServersForFamily(ANGULAR_LSP_FAMILY_ID)
      .some((server) => server.profileId === profileId && majorForProfile(profileId) != null);
    if (!valid) throw new ApiError('bad_input', 400, 'unknown Angular compatibility profile');
    setProjectLspProfileOverride(routed, {
      projectId,
      familyId: ANGULAR_LSP_FAMILY_ID,
      workspacePath: normalized,
      profileId,
    });
  }
  cache.get(db)?.delete(projectId);
  invalidateAngularWorkspaceIndex(projectRoot);
}
