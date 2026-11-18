import { describe, expect, it, vi } from 'vitest';
import { apiCall } from '../../../lib/api-client.js';
import { collectContributions, hydrateContributions, useContributions } from '../../../state/contribution-registry.js';

vi.mock('../../../lib/api-client.js', () => ({ apiCall: vi.fn() }));

describe('collectContributions', () => {
  it('keeps the latest checkout when the previous activation arrives late', async () => {
    let finish!: (value: unknown) => void;
    const earlier = new Promise(resolve => { finish = resolve; });
    const plugin = (id: string) => [{ namespace: id, enabled: true, contributions: { commands: [{ id, label: id }] } }];
    vi.mocked(apiCall).mockReturnValueOnce(earlier).mockResolvedValueOnce(plugin('linked'));
    const old = hydrateContributions(1);
    await hydrateContributions(2);
    finish(plugin('primary'));
    await old;
    expect(useContributions.getState().commands.map(c => c.id)).toEqual(['linked']);
  });
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
          editorActions: [{
            id: 'ea',
            label: 'EA',
            runsTool: 'echo',
            toolArgs: { mode: 'fast' },
            documentSelector: { filePatterns: ['Dockerfile'] },
            gutter: { line: { text: 'FROM', match: 'word' }, icon: 'build' },
          }],
          statusBarItems: [{ id: 'sb', label: 'SB', alignment: 'right' }],
          runConfigurations: [{ id: 'run', title: 'Run', command: 'npm' }],
          modules: [
            {
              id: 'node-project',
              title: 'Node Project',
              tools: ['echo'],
              editorActions: [{ id: 'module-ea', label: 'Module EA' }],
            },
          ],
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
    expect(result.editorActions.map((a) => a.id)).toEqual(['ea', 'module-ea']);
    expect(result.editorActions[0]).toMatchObject({
      pluginNs: 'a',
      toolArgs: { mode: 'fast' },
      documentSelector: { filePatterns: ['Dockerfile'] },
      gutter: { icon: 'build' },
    });
    expect(result.statusBarItems[0].id).toBe('sb');
    expect(result.runConfigurations[0].id).toBe('run');
    expect(result.modules[0].id).toBe('node-project');
  });
});
