import { create } from 'zustand';
import type { DebugBreakpoint, DebugSourceBreakpoint, DebugSourceBreakpoints } from '@mcp/api-bus';

const STORAGE_KEY = 'mcp-ide:debug-breakpoints:v1';
const EMPTY_BREAKPOINTS: DebugSourceBreakpoint[] = [];

type ProjectBreakpoints = Record<string, DebugSourceBreakpoint[]>;
type BreakpointsByProject = Record<string, ProjectBreakpoints>;

interface DebugBreakpointRuntimeStatus {
  sessionId: string;
  requestedLine: number;
  line: number;
  verified: boolean;
  message?: string;
}

const EMPTY_BREAKPOINT_RUNTIME: DebugBreakpointRuntimeStatus[] = [];

type RuntimeByProject = Record<string, Record<string, DebugBreakpointRuntimeStatus[]>>;

interface DebugBreakpointsState {
  byProject: BreakpointsByProject;
  runtimeByProject: RuntimeByProject;
}

function normalizedPath(path: string): string {
  return path.replace(/\\/g, '/').replace(/^\.\//, '');
}

function normalizedBreakpoints(breakpoints: DebugSourceBreakpoint[]): DebugSourceBreakpoint[] {
  const byLine = new Map<number, DebugSourceBreakpoint>();
  for (const breakpoint of breakpoints) {
    if (!Number.isInteger(breakpoint.line) || breakpoint.line < 1) continue;
    byLine.set(breakpoint.line, { ...breakpoint });
  }
  return [...byLine.values()].sort((a, b) => a.line - b.line);
}

function loadPersisted(): BreakpointsByProject {
  if (typeof localStorage === 'undefined') return {};
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null') as {
      version?: number;
      byProject?: BreakpointsByProject;
    } | null;
    if (parsed?.version !== 1 || !parsed.byProject || typeof parsed.byProject !== 'object') return {};
    const clean: BreakpointsByProject = {};
    for (const [projectId, files] of Object.entries(parsed.byProject)) {
      if (!files || typeof files !== 'object') continue;
      for (const [path, breakpoints] of Object.entries(files)) {
        if (!Array.isArray(breakpoints)) continue;
        const normalized = normalizedBreakpoints(breakpoints);
        if (normalized.length) (clean[projectId] ??= {})[normalizedPath(path)] = normalized;
      }
    }
    return clean;
  } catch {
    return {};
  }
}

function persist(byProject: BreakpointsByProject): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ version: 1, byProject }));
  } catch {
    // Breakpoints remain available for this renderer when storage is blocked.
  }
}

export const useDebugBreakpoints = create<DebugBreakpointsState>(() => ({
  byProject: loadPersisted(),
  runtimeByProject: {},
}));

export function selectDebugBreakpoints(
  state: DebugBreakpointsState,
  projectId: number,
  path: string,
): DebugSourceBreakpoint[] {
  return state.byProject[String(projectId)]?.[normalizedPath(path)] ?? EMPTY_BREAKPOINTS;
}

export function selectDebugBreakpointRuntime(
  state: DebugBreakpointsState,
  projectId: number,
  path: string,
  sessionId: string | undefined,
): DebugBreakpointRuntimeStatus[] {
  if (!sessionId) return EMPTY_BREAKPOINT_RUNTIME;
  const statuses = state.runtimeByProject[String(projectId)]?.[normalizedPath(path)];
  // setDebugBreakpointRuntime replaces the whole file entry, and every status
  // in that entry belongs to the same session. Return that store-owned array so
  // Zustand's useSyncExternalStore snapshot remains referentially stable.
  return statuses?.[0]?.sessionId === sessionId ? statuses : EMPTY_BREAKPOINT_RUNTIME;
}

export function replaceDebugBreakpoints(
  projectId: number,
  path: string,
  breakpoints: DebugSourceBreakpoint[],
): DebugSourceBreakpoint[] {
  const projectKey = String(projectId);
  const fileKey = normalizedPath(path);
  const normalized = normalizedBreakpoints(breakpoints);
  const current = useDebugBreakpoints.getState().byProject;
  const project = { ...(current[projectKey] ?? {}) };
  if (normalized.length) project[fileKey] = normalized;
  else delete project[fileKey];
  const byProject = { ...current };
  if (Object.keys(project).length) byProject[projectKey] = project;
  else delete byProject[projectKey];
  const runtimeByProject = { ...useDebugBreakpoints.getState().runtimeByProject };
  const runtimeProject = { ...(runtimeByProject[projectKey] ?? {}) };
  delete runtimeProject[fileKey];
  if (Object.keys(runtimeProject).length) runtimeByProject[projectKey] = runtimeProject;
  else delete runtimeByProject[projectKey];
  useDebugBreakpoints.setState({ byProject, runtimeByProject });
  persist(byProject);
  return normalized;
}

export function setDebugBreakpointRuntime(
  projectId: number,
  path: string,
  sessionId: string,
  requested: DebugSourceBreakpoint[],
  resolved: DebugBreakpoint[],
): void {
  const projectKey = String(projectId);
  const fileKey = normalizedPath(path);
  const statuses = requested.map((breakpoint, index): DebugBreakpointRuntimeStatus => {
    const result = resolved[index];
    return {
      sessionId,
      requestedLine: breakpoint.line,
      line: result?.line ?? breakpoint.line,
      verified: result?.verified ?? false,
      message: result?.message,
    };
  });
  const current = useDebugBreakpoints.getState().runtimeByProject;
  const project = { ...(current[projectKey] ?? {}) };
  if (statuses.length) project[fileKey] = statuses;
  else delete project[fileKey];
  const runtimeByProject = { ...current };
  if (Object.keys(project).length) runtimeByProject[projectKey] = project;
  else delete runtimeByProject[projectKey];
  useDebugBreakpoints.setState({ runtimeByProject });
}

export function toggleDebugBreakpoint(projectId: number, path: string, line: number): DebugSourceBreakpoint[] {
  const current = selectDebugBreakpoints(useDebugBreakpoints.getState(), projectId, path);
  const exists = current.some((breakpoint) => breakpoint.line === line);
  return replaceDebugBreakpoints(
    projectId,
    path,
    exists ? current.filter((breakpoint) => breakpoint.line !== line) : [...current, { line }],
  );
}

export function debugBreakpointsForProject(projectId: number): DebugSourceBreakpoints[] {
  const files = useDebugBreakpoints.getState().byProject[String(projectId)] ?? {};
  return Object.entries(files)
    .filter(([, breakpoints]) => breakpoints.length > 0)
    .map(([path, breakpoints]) => ({
      path,
      breakpoints: breakpoints.map((breakpoint) => ({ ...breakpoint })),
    }));
}

export function isJavaScriptDebugPath(path: string): boolean {
  return /\.(?:js|mjs|cjs|jsx|ts|mts|cts|tsx)$/i.test(path);
}
