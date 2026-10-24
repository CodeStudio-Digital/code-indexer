import type { SessionWorkbenchPluginCapability } from '@mcp/api-bus';
import type { FsCoderSession } from '@mcp/session-storage/fs-store/types.js';
import {
  isActivated,
  listInstalledPlugins,
  type ActivationRule,
} from '@mcp/plugin-host';
import type { ServerDeps } from '../../../deps.js';

interface ToolWindowContribution {
  id: string;
  title: string;
  icon?: string;
  side: 'left' | 'right' | 'bottom';
  activation?: ActivationRule;
}

interface ModuleContribution {
  activation?: ActivationRule;
  toolWindows: ToolWindowContribution[];
}

function object(value: unknown): Record<string, unknown> | null {
  return value != null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function activation(value: unknown): ActivationRule | undefined {
  const raw = object(value);
  if (!raw) return undefined;
  const whenFiles = Array.isArray(raw.whenFiles)
    ? raw.whenFiles.filter((item): item is string => typeof item === 'string')
    : undefined;
  const whenPackageDep = Array.isArray(raw.whenPackageDep)
    ? raw.whenPackageDep.filter((item): item is string => typeof item === 'string')
    : undefined;
  return {
    ...(whenFiles?.length ? { whenFiles } : {}),
    ...(whenPackageDep?.length ? { whenPackageDep } : {}),
  };
}

function toolWindows(value: unknown): ToolWindowContribution[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const raw = object(item);
    if (!raw) return [];
    if (
      typeof raw.id !== 'string' || !raw.id.trim() ||
      typeof raw.title !== 'string' || !raw.title.trim() ||
      (raw.side !== 'left' && raw.side !== 'right' && raw.side !== 'bottom')
    ) return [];
    return [{
      id: raw.id.trim(),
      title: raw.title.trim(),
      ...(typeof raw.icon === 'string' && raw.icon.trim() ? { icon: raw.icon.trim() } : {}),
      side: raw.side,
      ...(raw.activation === undefined ? {} : { activation: activation(raw.activation) }),
    }];
  });
}

function modules(value: unknown): ModuleContribution[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const raw = object(item);
    if (!raw) return [];
    return [{
      ...(raw.activation === undefined ? {} : { activation: activation(raw.activation) }),
      toolWindows: toolWindows(raw.toolWindows),
    }];
  });
}

/** Resolve the existing declarative plugin registry without executing plugin code. */
export function createSessionWorkbenchPluginCapabilityResolver(
  deps: Pick<ServerDeps, 'db'>,
): (session: FsCoderSession) => Promise<SessionWorkbenchPluginCapability[]> {
  return async (session) => {
    const primary = session.linked_projects.find((project) => project.is_primary)
      ?? session.linked_projects[0]
      ?? null;
    const root = primary == null
      ? null
      : deps.db.getProject(primary.project_id)?.root_path ?? null;
    const result: SessionWorkbenchPluginCapability[] = [];
    const seen = new Set<string>();

    for (const plugin of listInstalledPlugins()) {
      if (!plugin.enabled || !plugin.contributions) continue;
      const ownWindows = toolWindows(plugin.contributions.toolWindows);
      const moduleWindows = modules(plugin.contributions.modules)
        .filter((module) => isActivated(module.activation, root))
        .flatMap((module) => module.toolWindows);
      for (const window of [...ownWindows, ...moduleWindows]) {
        if (window.side !== 'right' || !isActivated(window.activation, root)) continue;
        const destinationId = `plugin:${plugin.namespace}:${window.id}` as const;
        if (seen.has(destinationId)) continue;
        seen.add(destinationId);
        result.push({
          destinationId,
          pluginId: plugin.namespace,
          label: window.title,
          iconId: window.icon ?? 'puzzle',
          preferredWidth: 'standard',
        });
      }
    }
    return result;
  };
}
