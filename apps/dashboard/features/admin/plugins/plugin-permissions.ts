/**
 * Human-readable summary of a plugin's granted capabilities (install ==
 * consent). Shared by the plugin list row and the detail pane. Moved out of
 * `PluginsPanel.tsx` so both surfaces format permissions identically.
 */
import type { PluginPermissionsShape } from '@mcp/api-bus';

export function summarizePermissions(
  p: PluginPermissionsShape | null | undefined,
  t: (key: string, options?: Record<string, unknown>) => string,
): string[] {
  if (!p) return [];
  const out: string[] = [];
  const reads = p.fs?.read?.length ?? 0;
  const writes = p.fs?.write?.length ?? 0;
  if (reads || writes) {
    out.push(
      t('panel.fsPermission', {
        reads,
        writesText: writes ? t('panel.fsWrites', { writes }) : '',
      }),
    );
  }
  if (p.exec?.allow?.length) out.push(`exec: ${p.exec.allow.join(', ')}`);
  if (p.storage) out.push(t('panel.storage'));
  return out;
}
