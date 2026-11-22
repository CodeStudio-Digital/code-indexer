import type { LspServerHandle } from './lsp-server-handle.js';
import type { AngularWorkspaceMarkers } from './angular-workspace-scanner.js';
import type { LspDiagnostic } from './lsp-protocol.js';
import type { LspRouteDescriptor } from './lsp-route.js';
import type { LspRuntimeResolution, LspServerDef } from './server-registry.js';

export type LspInstanceState =
  | 'no-server'
  | 'not-installed'
  | 'idle'
  | 'starting'
  | 'ready'
  | 'failed'
  | 'disabled';

export type LspAcquireIntent = 'status' | 'open' | 'background' | 'interactive' | 'manual';
export type LspWorkspaceMode = 'project' | 'generated-unity' | 'generated-basic' | 'loose';

export interface LspNodeRuntimeStatus {
  range: string;
  satisfied: boolean;
  source?: 'project' | 'app';
  version?: string;
  reason?: string;
}

export interface LspReplayDocument {
  file: string;
  languageId: string;
  version: number;
  content: string;
}

export interface LspManagerDeps {
  angularWorkspaces?: {
    cached(projectId: number, root: string): AngularWorkspaceMarkers | undefined;
    load(projectId: number, root: string): Promise<unknown>;
  };
  baseDir?: string;
  resolveNodeBin: (projectId: number) => string | null;
  resolveRoot: (projectId: number) => string | null;
  listProjectRoots?: () => string[];
  resolveRuntime: (
    projectId: number,
    requirement: NonNullable<LspServerDef['runtime']>,
  ) => LspRuntimeResolution;
  docsForReplay: (projectId: number, languages: string[]) => LspReplayDocument[];
  onDiagnostics: (
    projectId: number,
    absPath: string,
    serverId: string,
    diagnostics: LspDiagnostic[],
    routeId?: string,
  ) => void;
  onStateChange?: (
    projectId: number,
    serverId: string,
    state: LspInstanceState,
    reason?: string,
    routeId?: string,
  ) => void;
  onRoutingChange?: (projectId: number, languageId: string, routeId?: string) => void;
  onRouteRetired?: (projectId: number, serverId: string, routeId: string) => void;
  resolveLanguageLevel?: (projectId: number, serverId: string) => string | undefined;
  resolveLspConfig?: (projectId: number, serverId: string, section: string | null) => unknown;
  log?: (msg: string) => void;
}

export interface LspManagerStatus {
  state: LspInstanceState;
  server?: LspServerDef;
  reason?: string;
  runtime?: LspRuntimeResolution;
  nodeRuntime?: LspNodeRuntimeStatus;
  workspaceMode?: LspWorkspaceMode;
  workspaceReason?: string;
  routeId?: string;
  familyId?: string;
  profileId?: string;
}

export interface LspAcquiredServer {
  handle: LspServerHandle;
  def: LspServerDef;
  /** Effective process/workspace root. Legacy acquisitions return the project root. */
  root: string;
  routeId?: string;
  familyId?: string;
  profileId?: string;
}

/** Internal route metadata used to validate lifecycle requests before mutation. */
export interface LspBoundRouteTarget {
  routeId: string;
  serverId: string;
  languageId: string;
  familyId: string;
  profileId: string;
  /** Runtime-only; callers must not serialize this path into public payloads. */
  workspaceRoot: string;
}

export interface LspManagerEntry {
  def: LspServerDef;
  projectId: number;
  handle: LspServerHandle | null;
  spawning: Promise<LspServerHandle | null> | null;
  crashTimes: number[];
  idleTimer: ReturnType<typeof setTimeout> | null;
  lastExitReason?: string;
  workspaceMode?: LspWorkspaceMode;
  workspaceReason?: string;
  blockedReason?: string;
  route?: LspRouteDescriptor;
  routeEpoch?: number;
  workspaceRoot?: string;
  languageId?: string;
}

export interface LspManagerInstance {
  projectId: number;
  serverId: string;
  state: string;
  lastExitReason?: string;
  stderrTail?: string;
  requests?: ReturnType<LspServerHandle['requestStats']>;
  inactive?: boolean;
  lruEvictions?: number;
  workspaceMode?: LspWorkspaceMode;
  workspaceReason?: string;
  routeId?: string;
  familyId?: string;
  profileId?: string;
}

export interface LspRouteBinding {
  projectId: number;
  serverId: string;
  languageId: string;
  route: LspRouteDescriptor;
  workspaceRoot: string;
}

export interface LspRouteSelection {
  projectId: number;
  languageId: string;
  serverId?: string;
  routeId?: string;
}
