import { describe, expect, it } from 'vitest';
import { collectContributions } from '../../../state/contribution-registry.js';
import { buildThemeCommands } from '../registries/commands.js';

describe('collectContributions', () => {
  it('flattens enabled plugins, tags namespace, skips disabled/empty', () => {
    const result = collectContributions([
      {
        namespace: 'a',
        enabled: true,
        contributions: {
          themes: [
            { id: 'dark', label: 'A Dark', appearance: 'dark', tokens: { '--primary': '#111' } },
          ],
          commands: [{ id: 'c', label: 'C' }],
          toolWindows: [{ id: 'w', title: 'W', side: 'right', entry: 'ui/p.html' }],
        },
      },
      {
        namespace: 'b',
        enabled: false,
        contributions: { themes: [{ id: 'x', label: 'X', appearance: 'light', tokens: {} }] },
      },
      { namespace: 'c', enabled: true, contributions: null },
    ]);
    expect(result.themes).toHaveLength(1);
    expect(result.themes[0].pluginNs).toBe('a');
    expect(result.commands).toHaveLength(1);
    expect(result.toolWindows[0].side).toBe('right');
  });
});

describe('buildThemeCommands', () => {
  it('makes one apply-theme palette command per theme', () => {
    const cmds = buildThemeCommands([
      { pluginNs: 'a', id: 'dark', label: 'A Dark', appearance: 'dark', tokens: {} },
    ]);
    expect(cmds).toHaveLength(1);
    expect(cmds[0].id).toBe('plugin.a.theme.dark');
    expect(cmds[0].category).toBe('Themes');
    expect(cmds[0].label).toBe('Apply theme: A Dark');
    expect(typeof cmds[0].run).toBe('function');
  });
});
