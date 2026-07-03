import { describe, expect, it } from 'vitest';
import {
  definePlugin,
  contributeTool,
  contributeCommand,
  contributeProjectModule,
  contributeEditorAction,
  contributeStatusBarItem,
  contributeRunConfiguration,
} from '@mcp/plugin-sdk/define.js';

describe('definePlugin', () => {
  it('collects contributions with empty defaults', () => {
    const mod = definePlugin({});
    expect(mod.tools).toEqual([]);
    expect(mod.toolWindows).toEqual([]);
    expect(mod.commands).toEqual([]);
    expect(mod.themes).toEqual([]);
    expect(mod.editorActions).toEqual([]);
    expect(mod.statusBarItems).toEqual([]);
    expect(mod.runConfigurations).toEqual([]);
    expect(mod.modules).toEqual([]);
  });

  it('keeps tool handlers and declarative fields', async () => {
    const mod = definePlugin({
      tools: [
        contributeTool({
          name: 'echo',
          description: 'Echoes input',
          parameters: { type: 'object', properties: { text: { type: 'string' } } },
          mutates: false,
          handler: async (args) => ({ content: String(args.text) }),
        }),
      ],
      commands: [contributeCommand({ id: 'c', label: 'C' })],
      modules: [
        contributeProjectModule({
          id: 'node-project',
          title: 'Node Project',
          activation: { whenFiles: ['package.json'] },
          editorActions: [
            contributeEditorAction({ id: 'echo-editor', label: 'Echo', runsTool: 'echo' }),
          ],
          statusBarItems: [
            contributeStatusBarItem({ id: 'echo-status', label: 'Echo', runsTool: 'echo' }),
          ],
          runConfigurations: [
            contributeRunConfiguration({
              id: 'npm-test',
              title: 'npm test',
              command: 'npm',
              args: ['test'],
            }),
          ],
        }),
      ],
    });
    expect(mod.tools[0].name).toBe('echo');
    expect(mod.tools[0].mutates).toBe(false);
    const res = await mod.tools[0].handler({ text: 'hi' }, {} as never);
    expect(res.content).toBe('hi');
    expect(mod.commands[0].id).toBe('c');
    expect(mod.modules[0].id).toBe('node-project');
    expect(mod.modules[0].editorActions?.[0].runsTool).toBe('echo');
  });
});
