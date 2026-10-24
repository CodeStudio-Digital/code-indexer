/**
 * Plugin UI contribution registry. Hydrated from `plugins.list` (the stored
 * .app.json contributions per installed plugin) and consumed by the
 * workspace: themes, commands, and tool windows contributed by plugins.
 *
 * `collectContributions` is a pure function (unit-tested); the Zustand store
 * + `hydrateContributions` wrap it for React consumers.
 */
import { create } from 'zustand';
import { apiCall } from '../lib/api-client.js';

interface ContribTheme {
  pluginNs: string;
  id: string;
  label: string;
  appearance: 'dark' | 'light';
  tokens: Record<string, string>;
}

interface ContribCommand {
  pluginNs: string;
  id: string;
  label: string;
  category?: string;
  shortcut?: string;
  runsTool?: string;
}

export interface ContribEditorAction {
  pluginNs: string;
  id: string;
  label: string;
  category?: string;
  icon?: string;
  shortcut?: string;
  runsTool?: string;
  toolArgs?: Record<string, unknown>;
  documentSelector?: {
    filePatterns?: string[];
    languageIds?: string[];
  };
  gutter?: {
    line: {
      text: string;
      match: 'equals' | 'startsWith' | 'contains' | 'word';
      trim?: boolean;
      caseSensitive?: boolean;
    };
    occurrence?: 'first' | 'all';
    icon?: 'run' | 'build' | 'inspect';
    tooltip?: string;
  };
  scope?: 'editor' | 'project' | 'module';
}

export interface ContribStatusBarItem {
  pluginNs: string;
  id: string;
  label: string;
  tooltip?: string;
  icon?: string;
  alignment?: 'left' | 'right';
  priority?: number;
  runsTool?: string;
  scope?: 'application' | 'project' | 'module';
}

interface ContribRunConfiguration {
  pluginNs: string;
  id: string;
  title: string;
  description?: string;
  icon?: string;
  kind?: string;
  command: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  scope?: 'project' | 'module';
}

export interface ContribToolWindow {
  pluginNs: string;
  id: string;
  title: string;
  /** Optional icon name from the small lucide allowlist (see plugin-icon.ts). */
  icon?: string;
  side: 'left' | 'right' | 'bottom';
  entry: string;
}

interface ContribProjectModule {
  pluginNs: string;
  id: string;
  title: string;
  description?: string;
  icon?: string;
  tools?: string[];
}

interface CollectedContributions {
  themes: ContribTheme[];
  commands: ContribCommand[];
  toolWindows: ContribToolWindow[];
  editorActions: ContribEditorAction[];
  statusBarItems: ContribStatusBarItem[];
  runConfigurations: ContribRunConfiguration[];
  modules: ContribProjectModule[];
}

interface RawPlugin {
  namespace: string;
  enabled: boolean;
  contributions: {
    themes?: Array<Omit<ContribTheme, 'pluginNs'>>;
    commands?: Array<Omit<ContribCommand, 'pluginNs'>>;
    toolWindows?: Array<Omit<ContribToolWindow, 'pluginNs'>>;
    editorActions?: Array<Omit<ContribEditorAction, 'pluginNs'>>;
    statusBarItems?: Array<Omit<ContribStatusBarItem, 'pluginNs'>>;
    runConfigurations?: Array<Omit<ContribRunConfiguration, 'pluginNs'>>;
    modules?: Array<
      Omit<ContribProjectModule, 'pluginNs'> & {
        toolWindows?: Array<Omit<ContribToolWindow, 'pluginNs'>>;
        editorActions?: Array<Omit<ContribEditorAction, 'pluginNs'>>;
        statusBarItems?: Array<Omit<ContribStatusBarItem, 'pluginNs'>>;
        runConfigurations?: Array<Omit<ContribRunConfiguration, 'pluginNs'>>;
      }
    >;
  } | null;
}

/** Flatten enabled plugins' contributions, tagging each with its namespace. */
export function collectContributions(plugins: RawPlugin[]): CollectedContributions {
  const themes: ContribTheme[] = [];
  const commands: ContribCommand[] = [];
  const toolWindows: ContribToolWindow[] = [];
  const editorActions: ContribEditorAction[] = [];
  const statusBarItems: ContribStatusBarItem[] = [];
  const runConfigurations: ContribRunConfiguration[] = [];
  const modules: ContribProjectModule[] = [];
  for (const p of plugins) {
    if (!p.enabled || !p.contributions) continue;
    const c = p.contributions;
    for (const t of c.themes ?? []) themes.push({ pluginNs: p.namespace, ...t });
    for (const cmd of c.commands ?? []) commands.push({ pluginNs: p.namespace, ...cmd });
    for (const w of c.toolWindows ?? []) toolWindows.push({ pluginNs: p.namespace, ...w });
    for (const a of c.editorActions ?? []) editorActions.push({ pluginNs: p.namespace, ...a });
    for (const item of c.statusBarItems ?? []) statusBarItems.push({ pluginNs: p.namespace, ...item });
    for (const run of c.runConfigurations ?? []) runConfigurations.push({ pluginNs: p.namespace, ...run });
    for (const mod of c.modules ?? []) {
      const { toolWindows: moduleWindows, editorActions: moduleActions, statusBarItems: moduleItems, runConfigurations: moduleRuns, ...moduleDecl } = mod;
      modules.push({ pluginNs: p.namespace, ...moduleDecl });
      for (const w of moduleWindows ?? []) toolWindows.push({ pluginNs: p.namespace, ...w });
      for (const a of moduleActions ?? []) editorActions.push({ pluginNs: p.namespace, ...a });
      for (const item of moduleItems ?? []) statusBarItems.push({ pluginNs: p.namespace, ...item });
      for (const run of moduleRuns ?? []) runConfigurations.push({ pluginNs: p.namespace, ...run });
    }
  }
  return { themes, commands, toolWindows, editorActions, statusBarItems, runConfigurations, modules };
}

interface ContributionState extends CollectedContributions {
  hydrated: boolean;
  setContributions: (c: CollectedContributions) => void;
}

export const useContributions = create<ContributionState>((set) => ({
  themes: [],
  commands: [],
  toolWindows: [],
  editorActions: [],
  statusBarItems: [],
  runConfigurations: [],
  modules: [],
  hydrated: false,
  setContributions: (c) => set({ ...c, hydrated: true }),
}));

/**
 * Fetch installed plugins + populate the registry. Pass a `projectId` to get
 * activation-filtered contributions (tool windows whose `activation` rule
 * matches the project — auto-detection), so panels surface only in relevant
 * projects. Without it, `plugins.list` returns everything (used outside a
 * project context). Safe to call on mount.
 */
export async function hydrateContributions(projectId?: number): Promise<void> {
  try {
    const plugins =
      projectId != null
        ? await apiCall<RawPlugin[]>('plugins.activeContributions', { projectId })
        : await apiCall<RawPlugin[]>('plugins.list', undefined);
    useContributions.getState().setContributions(collectContributions(plugins));
  } catch {
    /* backend not ready / no plugins installed — leave the registry empty */
  }
}
