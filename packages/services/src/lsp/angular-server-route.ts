/** Selects one pinned Angular Language Server profile for one editor file. */
import {
  resolveAngularWorkspace,
  type AngularWorkspaceIndexOptions,
  type AngularWorkspaceResolution,
} from './angular-workspace-index.js';
import type { LspServerDef } from './lsp-server-types.js';
import type { LspRouteIdentity } from './lsp-route.js';

export type AngularRouteState =
  | 'selected'
  | 'not-angular'
  | 'needs-profile'
  | 'unsupported'
  | 'disabled';

export interface AngularServerRoute {
  state: AngularRouteState;
  def?: LspServerDef;
  workspace?: AngularWorkspaceResolution;
  familyId?: string;
  profileId?: string;
  workspaceId?: string;
  supportTier?: LspServerDef['supportTier'];
  reason?: string;
}

export interface AngularServerRouteOptions extends AngularWorkspaceIndexOptions {
  enabled?: boolean;
  legacyEnabled?: boolean;
  disabledMajors?: ReadonlySet<number>;
}

function majorFromRange(range: string | undefined): number | null {
  if (!range) return null;
  const match = /^>=(\d+)\.0\.0\s+<(\d+)\.0\.0$/.exec(range.trim());
  if (!match || Number(match[2]) !== Number(match[1]) + 1) return null;
  return Number(match[1]);
}

function disabledMajorsFromEnv(): Set<number> {
  return new Set(
    (process.env.MCP_ANGULAR_LSP_DISABLED_MAJORS ?? '')
      .split(',')
      .map((value) => Number(value.trim()))
      .filter((value) => Number.isInteger(value) && value > 0),
  );
}

export function resolveAngularServerRoute(
  projectRoot: string,
  file: string,
  profiles: readonly LspServerDef[],
  options: AngularServerRouteOptions = {},
): AngularServerRoute {
  const enabled = options.enabled ?? process.env.MCP_ANGULAR_LSP_ENABLED !== '0';
  if (!enabled) return { state: 'disabled', reason: 'Angular language support is disabled' };
  const workspace = resolveAngularWorkspace(projectRoot, file, options);
  if (!workspace) return { state: 'not-angular' };
  const familyId = profiles[0]?.familyId ?? profiles[0]?.id;
  if (workspace.major == null) {
    return {
      state: 'needs-profile', workspace, familyId, workspaceId: workspace.id,
      reason: 'Angular version could not be determined safely',
    };
  }
  const disabledMajors = options.disabledMajors ?? disabledMajorsFromEnv();
  if (disabledMajors.has(workspace.major)) {
    return {
      state: 'disabled', workspace, familyId, workspaceId: workspace.id,
      reason: `Angular ${workspace.major} is quarantined`,
    };
  }
  const def = profiles.find((candidate) => majorFromRange(candidate.projectRange) === workspace.major);
  if (!def || def.supportTier === 'unsupported') {
    return {
      state: 'unsupported', workspace, familyId, workspaceId: workspace.id,
      reason: `Angular ${workspace.major} has no qualified server profile`,
    };
  }
  const legacyEnabled = options.legacyEnabled ?? process.env.MCP_ANGULAR_LSP_LEGACY !== '0';
  if (def.supportTier === 'best-effort' && !legacyEnabled) {
    return {
      state: 'disabled', workspace, familyId, profileId: def.profileId,
      workspaceId: workspace.id, supportTier: def.supportTier,
      reason: `Legacy Angular ${workspace.major} support is disabled`,
    };
  }
  return {
    state: 'selected',
    def,
    workspace,
    familyId: def.familyId ?? def.id,
    profileId: def.profileId,
    workspaceId: workspace.id,
    supportTier: def.supportTier,
  };
}

export function angularRouteIdentity(route: AngularServerRoute): LspRouteIdentity | null {
  if (route.state !== 'selected' || !route.workspace || !route.familyId || !route.profileId) return null;
  return {
    familyId: route.familyId,
    profileId: route.profileId,
    workspaceFingerprint: route.workspace.fingerprint,
    workspaceRoot: route.workspace.workspaceRoot,
  };
}
