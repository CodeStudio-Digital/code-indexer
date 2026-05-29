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

export interface ContribTheme {
  pluginNs: string;
  id: string;
  label: string;
  appearance: 'dark' | 'light';
  tokens: Record<string, string>;
}

export interface ContribCommand {
  pluginNs: string;
  id: string;
  label: string;
  category?: string;
  shortcut?: string;
  runsTool?: string;
}

export interface ContribToolWindow {
  pluginNs: string;
  id: string;
  title: string;
  side: 'left' | 'right' | 'bottom';
  entry: string;
}

export interface CollectedContributions {
  themes: ContribTheme[];
  commands: ContribCommand[];
  toolWindows: ContribToolWindow[];
}

interface RawPlugin {
  namespace: string;
  enabled: boolean;
  contributions: {
    themes?: Array<Omit<ContribTheme, 'pluginNs'>>;
    commands?: Array<Omit<ContribCommand, 'pluginNs'>>;
    toolWindows?: Array<Omit<ContribToolWindow, 'pluginNs'>>;
  } | null;
}

/** Flatten enabled plugins' contributions, tagging each with its namespace. */
export function collectContributions(plugins: RawPlugin[]): CollectedContributions {
  const themes: ContribTheme[] = [];
  const commands: ContribCommand[] = [];
  const toolWindows: ContribToolWindow[] = [];
  for (const p of plugins) {
    if (!p.enabled || !p.contributions) continue;
    const c = p.contributions;
    for (const t of c.themes ?? []) themes.push({ pluginNs: p.namespace, ...t });
    for (const cmd of c.commands ?? []) commands.push({ pluginNs: p.namespace, ...cmd });
    for (const w of c.toolWindows ?? []) toolWindows.push({ pluginNs: p.namespace, ...w });
  }
  return { themes, commands, toolWindows };
}

interface ContributionState extends CollectedContributions {
  hydrated: boolean;
  setContributions: (c: CollectedContributions) => void;
}

export const useContributions = create<ContributionState>((set) => ({
  themes: [],
  commands: [],
  toolWindows: [],
  hydrated: false,
  setContributions: (c) => set({ ...c, hydrated: true }),
}));

/** Fetch installed plugins + populate the registry. Safe to call on mount. */
export async function hydrateContributions(): Promise<void> {
  try {
    const plugins = await apiCall<RawPlugin[]>('plugins.list', undefined);
    useContributions.getState().setContributions(collectContributions(plugins));
  } catch {
    /* backend not ready / no plugins installed — leave the registry empty */
  }
}
