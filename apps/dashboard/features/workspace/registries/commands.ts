/**
 * Build command-palette entries from plugin contributions. v1 ships the
 * functional ones — "Apply theme: X" — which apply a contributed theme with
 * zero backend round-trip. Generic plugin commands (runsTool) land with the
 * plugins.invokeTool wiring in the next slice.
 */
import type { Command } from '../jetbrains/CommandPalette.js';
import type { ContribTheme } from '../../../state/contribution-registry.js';
import { applyPluginTheme } from '../theme-apply.js';

export function buildThemeCommands(themes: ContribTheme[]): Command[] {
  return themes.map((t) => ({
    id: `plugin.${t.pluginNs}.theme.${t.id}`,
    category: 'Themes',
    label: `Apply theme: ${t.label}`,
    run: () => applyPluginTheme(t.tokens, t.appearance),
  }));
}
