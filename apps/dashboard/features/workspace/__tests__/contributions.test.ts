import { describe, expect, it } from 'vitest';
import { collectContributions } from '../../../state/contribution-registry.js';

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
          toolWindows: [{ id: 'w', title: 'W', icon: 'cloud', side: 'right', entry: 'ui/p.html' }],
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
    // Declared icon names ride along (rails map them via pluginWindowIcon).
    expect(result.toolWindows[0].icon).toBe('cloud');
  });
});
