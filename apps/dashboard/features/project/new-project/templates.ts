/**
 * Front-end catalog of the stacks the New Project wizard can scaffold.
 * Mirrors the backend host-scaffold registry
 * (packages/services/src/host-scaffold/templates/registry.ts) — keep the
 * ids in sync. Labels/descriptions resolve from the `projects` i18n
 * namespace (flat dotted keys, e.g. `wizard.tpl.react-vite.label`).
 */
import {
  Atom,
  Cloud,
  CloudCog,
  CloudLightning,
  FolderPlus,
  GitBranch,
  Hexagon,
  Server,
  Triangle,
  type LucideIcon,
} from 'lucide-react';

export type TemplateId =
  | 'react-vite'
  | 'vue'
  | 'angular'
  | 'vite-api'
  | 'cf-worker'
  | 'nextjs'
  | 'opennext-cf'
  | 'vite-react-cf'
  | 'git-clone'
  | 'empty';

export type TemplateGroup = 'frontend' | 'fullstack' | 'edge' | 'start';

export interface TemplateMeta {
  id: TemplateId;
  icon: LucideIcon;
  group: TemplateGroup;
  needsNetwork: boolean;
  requiresRepoUrl?: boolean;
}

export const TEMPLATES: TemplateMeta[] = [
  { id: 'react-vite', icon: Atom, group: 'frontend', needsNetwork: true },
  { id: 'vue', icon: Hexagon, group: 'frontend', needsNetwork: true },
  { id: 'angular', icon: Hexagon, group: 'frontend', needsNetwork: true },
  { id: 'nextjs', icon: Triangle, group: 'fullstack', needsNetwork: true },
  { id: 'vite-api', icon: Server, group: 'fullstack', needsNetwork: true },
  { id: 'cf-worker', icon: Cloud, group: 'edge', needsNetwork: true },
  { id: 'opennext-cf', icon: CloudCog, group: 'edge', needsNetwork: true },
  { id: 'vite-react-cf', icon: CloudLightning, group: 'edge', needsNetwork: true },
  { id: 'git-clone', icon: GitBranch, group: 'start', needsNetwork: true, requiresRepoUrl: true },
  { id: 'empty', icon: FolderPlus, group: 'start', needsNetwork: false },
];

export const TEMPLATE_GROUPS: TemplateGroup[] = ['frontend', 'fullstack', 'edge', 'start'];

export function templateById(id: TemplateId): TemplateMeta {
  return TEMPLATES.find((t) => t.id === id)!;
}
