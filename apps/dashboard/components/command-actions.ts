import type { ComponentType } from 'react';
import { FolderGit2, Languages, MessageSquare, Moon } from 'lucide-react';

/**
 * Pure builder + filter for the ⌘K command palette. Kept free of React/i18n
 * so it can be unit-tested in isolation — the component injects already
 * resolved sources (nav items, projects, recent sessions) and callbacks.
 */

export type CommandGroup = 'nav' | 'projects' | 'recent' | 'actions';

export interface CommandAction {
  id: string;
  label: string;
  /** Secondary line (e.g. a session's project name). Also matched on filter. */
  hint?: string;
  group: CommandGroup;
  icon: ComponentType<{ className?: string }>;
  run: () => void;
}

interface NavSource {
  id: string;
  label: string;
  href: string;
  icon: ComponentType<{ className?: string }>;
}

export interface CommandSources {
  nav: NavSource[];
  projects: Array<{ id: number; name: string }>;
  recent: Array<{ id: number; title: string; project_id: number; project_name: string }>;
  navigate: (to: string) => void;
  toggleTheme: () => void;
  toggleLanguage: () => void;
  labels: { toggleTheme: string; toggleLanguage: string };
}

export function buildCommandActions(s: CommandSources): CommandAction[] {
  return [
    ...s.nav.map((n): CommandAction => ({
      id: `nav:${n.id}`,
      label: n.label,
      group: 'nav',
      icon: n.icon,
      run: () => s.navigate(n.href),
    })),
    ...s.projects.map((p): CommandAction => ({
      id: `project:${p.id}`,
      label: p.name,
      group: 'projects',
      icon: FolderGit2,
      run: () => s.navigate(`/projects/${p.id}`),
    })),
    ...s.recent.map((r): CommandAction => ({
      id: `recent:${r.id}`,
      label: r.title,
      hint: r.project_name,
      group: 'recent',
      icon: MessageSquare,
      run: () => s.navigate(`/projects/${r.project_id}?session=${r.id}`),
    })),
    { id: 'action:theme', label: s.labels.toggleTheme, group: 'actions', icon: Moon, run: s.toggleTheme },
    { id: 'action:lang', label: s.labels.toggleLanguage, group: 'actions', icon: Languages, run: s.toggleLanguage },
  ];
}

export function filterCommands(actions: CommandAction[], query: string): CommandAction[] {
  const q = query.trim().toLowerCase();
  if (!q) return actions;
  return actions.filter(
    (a) => a.label.toLowerCase().includes(q) || (a.hint?.toLowerCase().includes(q) ?? false),
  );
}
