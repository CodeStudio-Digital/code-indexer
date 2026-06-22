/** Resource registry that drives the nav rail. Pure metadata — the columns and
 *  row actions live in columns.ts, the create forms in forms.ts. */
export type CreateKind = 'run' | 'pull' | 'volume' | 'network' | 'pod';

export interface ResourceMeta {
  id: string;
  /** SDK icon name shown in the rail. */
  icon: string;
  /** i18n key of the section header above the item. */
  group: string;
  /** Solo views (project, assistant) render their own content, no table. */
  solo?: boolean;
  listTool?: string;
  listArgs?: Record<string, unknown>;
  create?: CreateKind;
}

export const RESOURCES: ResourceMeta[] = [
  { id: 'containers', icon: 'box', group: 'group.compute', listTool: 'podman_ps', listArgs: { all: true }, create: 'run' },
  { id: 'images', icon: 'layers', group: 'group.compute', listTool: 'podman_images', create: 'pull' },
  { id: 'volumes', icon: 'database', group: 'group.storage', listTool: 'podman_volume_ls', create: 'volume' },
  { id: 'networks', icon: 'network', group: 'group.network', listTool: 'podman_network_ls', create: 'network' },
  { id: 'pods', icon: 'boxes', group: 'group.network', listTool: 'podman_pod_ps', create: 'pod' },
  { id: 'project', icon: 'folder', group: 'group.tools', solo: true },
  { id: 'assistant', icon: 'sparkles', group: 'group.tools', solo: true },
];

export function resource(id: string): ResourceMeta | undefined {
  return RESOURCES.find((r) => r.id === id);
}
