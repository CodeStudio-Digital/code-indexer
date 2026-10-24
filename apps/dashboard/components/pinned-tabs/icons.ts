/**
 * Serializable icon resolution for pins. Pins store a lucide icon NAME
 * (string) so they survive JSON round-trips; `iconFor` maps it back to a
 * component with a generic fallback so a renamed/unknown icon never crashes a
 * restored pin. `RAIL_ICON_NAME` mirrors `features/project/tabs-config.ts` so a
 * rail pin gets the same glyph as its rail button.
 */
import {
  BookOpen,
  Brain,
  Database,
  FileCode2,
  FolderGit2,
  GitBranch,
  MessageSquareCode,
  Pin,
  Server,
  Users,
  Webhook,
  Workflow,
  type LucideIcon,
} from 'lucide-react';

const ICON_BY_NAME: Record<string, LucideIcon> = {
  FolderGit2,
  MessageSquareCode,
  Users,
  FileCode2,
  GitBranch,
  Webhook,
  Server,
  Workflow,
  Database,
  BookOpen,
  Brain,
  Pin,
};

export function iconFor(name: string): LucideIcon {
  return ICON_BY_NAME[name] ?? Pin;
}

/** ProjectTabId → lucide icon NAME (mirrors tabs-config.ts TABS). */
const RAIL_ICON_NAME: Record<string, string> = {
  chat: 'MessageSquareCode',
  files: 'FileCode2',
  git: 'GitBranch',
  api: 'Webhook',
  databases: 'Server',
  diagrams: 'Workflow',
  index: 'Database',
  snapshots: 'BookOpen',
  memory: 'Brain',
};

export function railIconName(tabId: string): string {
  return RAIL_ICON_NAME[tabId] ?? 'Server';
}
