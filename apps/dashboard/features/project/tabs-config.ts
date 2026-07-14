/** Workbench surface registry for the project route. */
import {
  BookOpen,
  Brain,
  Code2,
  Database,
  FileCode2,
  GitBranch,
  MessageSquareCode,
  Monitor,
  PanelRightOpen,
  Server,
  Webhook,
  Workflow,
  type LucideIcon,
} from 'lucide-react';

export type ProjectTabId = string;
export type ProjectSurfaceKind = 'left' | 'right' | 'primary';

export interface TabDef {
  id: ProjectTabId;
  label: string;
  icon: LucideIcon;
  kind: ProjectSurfaceKind;
  group: 'core' | 'analytics' | 'plugins';
  separatorBefore?: boolean;
}

export const LEFT_TOOL_TABS: TabDef[] = [
  { id: 'files', label: 'Files', icon: FileCode2, kind: 'left', group: 'core' },
  { id: 'git', label: 'Git', icon: GitBranch, kind: 'left', group: 'core' },
  { id: 'sessions', label: 'Sessions', icon: MessageSquareCode, kind: 'left', group: 'core', separatorBefore: true },
  { id: 'api-navigation', label: 'API', icon: Webhook, kind: 'left', group: 'core' },
  { id: 'databases', label: 'Databases', icon: Database, kind: 'left', group: 'core' },
];

export const RIGHT_TOOL_TABS: TabDef[] = [
  { id: 'chat', label: 'AI Chat', icon: MessageSquareCode, kind: 'right', group: 'core' },
  { id: 'snapshots', label: 'Snapshots', icon: BookOpen, kind: 'right', group: 'analytics' },
  { id: 'memory', label: 'Memory', icon: Brain, kind: 'right', group: 'analytics' },
];

/** Context-only tool shown on the right rail while the API surface is active. */
export const API_RIGHT_TOOL: TabDef = {
  id: 'api-inspector',
  label: 'API response',
  icon: PanelRightOpen,
  kind: 'right',
  group: 'core',
};

export const PRIMARY_SURFACES: TabDef[] = [
  { id: 'editor', label: 'Code', icon: Code2, kind: 'primary', group: 'core' },
  { id: 'sessions', label: 'Session', icon: MessageSquareCode, kind: 'primary', group: 'core' },
  { id: 'api', label: 'API', icon: Webhook, kind: 'primary', group: 'core' },
  { id: 'ssh', label: 'SSH', icon: Server, kind: 'primary', group: 'core' },
  { id: 'diagrams', label: 'Diagrams', icon: Workflow, kind: 'primary', group: 'core' },
  { id: 'index', label: 'Index', icon: Database, kind: 'primary', group: 'analytics' },
  { id: 'preview', label: 'Preview', icon: Monitor, kind: 'primary', group: 'core' },
];

/**
 * Compatibility catalog consumed by pins and deep links. `editor` is omitted
 * from old rail pin affordances by their callers, but remains discoverable.
 */
export const TABS: TabDef[] = [
  ...LEFT_TOOL_TABS,
  ...RIGHT_TOOL_TABS,
  API_RIGHT_TOOL,
  ...PRIMARY_SURFACES,
];

export function projectSurface(id: string): TabDef | undefined {
  return TABS.find((surface) => surface.id === id);
}

export function projectSurfacesFor(kind: ProjectSurfaceKind): TabDef[] {
  return TABS.filter((surface) => surface.kind === kind);
}

/** Context-owned docks must never survive after their primary surface closes. */
export function projectToolAvailableInContext(toolId: string | null, primarySurface: string): boolean {
  if (toolId === 'api-navigation' || toolId === 'api-inspector') return primarySurface === 'api';
  return true;
}
