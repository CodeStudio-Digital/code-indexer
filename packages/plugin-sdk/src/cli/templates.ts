/** Static scaffold contents for `create-plugin`. Kept here so the command
 *  files stay tiny. */

export const PLUGIN_JSON = (slug: string): string =>
  `${JSON.stringify(
    {
      name: slug,
      version: '0.1.0',
      description: 'A new MCP IDE plugin.',
      author: { name: 'Your Name' },
      apps: './.app.json',
    },
    null,
    2,
  )}\n`;

export const PLUGIN_TS = `import {
  definePlugin,
  contributeTool,
  contributeToolWindow,
  contributeCommand,
  contributeTheme,
} from '@mcp/plugin-sdk/define';

export default definePlugin({
  tools: [
    contributeTool({
      name: 'echo',
      description: 'Echo the provided text back.',
      parameters: {
        type: 'object',
        properties: { text: { type: 'string', description: 'Text to echo' } },
        required: ['text'],
      },
      mutates: false,
      handler: async (args) => ({ content: String(args.text ?? '') }),
    }),
  ],
  toolWindows: [
    contributeToolWindow({ id: 'hello-panel', title: 'Hello', side: 'right', entry: 'ui/panel.html' }),
  ],
  commands: [contributeCommand({ id: 'hello-echo', label: 'Hello: Echo', runsTool: 'echo' })],
  themes: [
    contributeTheme({
      id: 'hello-dark',
      label: 'Hello Dark',
      appearance: 'dark',
      tokens: { '--primary': '#4d8cff' },
    }),
  ],
});
`;

export const PANEL_HTML = `<!doctype html>
<html>
  <head><meta charset="utf-8" /><title>Hello</title></head>
  <body style="font-family: sans-serif; padding: 12px;">
    <h3>Hello from a plugin webview</h3>
    <p>This iframe is sandboxed. Talk to the host via the injected bridge.</p>
  </body>
</html>
`;

export const GITIGNORE = 'dist/\nnode_modules/\n';
