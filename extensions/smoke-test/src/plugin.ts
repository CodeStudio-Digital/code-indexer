/**
 * Smoke-test plugin — exercises the whole Phase A+B stack end to end:
 *   - a plain `echo` tool (no capability)
 *   - `save_note` / `read_note` using ctx.storage (storage capability →
 *     hostInvoke choke point → PluginStorageStore)
 * plus a webview that drives all three via window.mcp.invokeTool and inherits
 * the host theme. Install it (capabilities auto-granted), open the "Smoke Test"
 * tab in a project's bottom panel, and click the buttons.
 */
import {
  definePlugin,
  contributeTool,
  contributeToolWindow,
} from '@mcp/plugin-sdk/define.js';

export default definePlugin({
  permissions: { storage: true },
  tools: [
    contributeTool({
      name: 'echo',
      description: 'Echo back the provided text',
      riskLevel: 'read',
      mutates: false,
      parameters: {
        type: 'object',
        properties: { text: { type: 'string' } },
        required: ['text'],
      },
      handler: async (args) => ({
        content: `echo: ${String((args as { text?: string }).text ?? '')}`,
      }),
    }),
    contributeTool({
      name: 'save_note',
      description: 'Persist a note in per-plugin storage',
      riskLevel: 'write',
      mutates: true,
      parameters: {
        type: 'object',
        properties: { text: { type: 'string' } },
        required: ['text'],
      },
      handler: async (args, ctx) => {
        const text = String((args as { text?: string }).text ?? '');
        if (!ctx.storage) return { content: 'storage capability not granted', isError: true };
        await ctx.storage.set('note', text);
        return { content: `saved: ${text}` };
      },
    }),
    contributeTool({
      name: 'read_note',
      description: 'Read the saved note back from per-plugin storage',
      riskLevel: 'read',
      mutates: false,
      parameters: { type: 'object', properties: {} },
      handler: async (_args, ctx) => {
        if (!ctx.storage) return { content: 'storage capability not granted', isError: true };
        const note = await ctx.storage.get('note');
        return { content: note === null ? '(no note saved yet)' : `note: ${note}` };
      },
    }),
  ],
  toolWindows: [
    contributeToolWindow({
      id: 'smoke-panel',
      title: 'Smoke Test',
      side: 'bottom',
      entry: 'ui/panel.html',
    }),
  ],
});
