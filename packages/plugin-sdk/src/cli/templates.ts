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
  contributeProjectModule,
  contributeEditorAction,
  contributeStatusBarItem,
  contributeRunConfiguration,
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
  modules: [
    contributeProjectModule({
      id: 'node-project',
      title: 'Node Project',
      description: 'Example project module activated by package.json.',
      activation: { whenFiles: ['package.json'] },
      tools: ['echo'],
      editorActions: [
        contributeEditorAction({
          id: 'hello-echo-editor',
          label: 'Hello: Echo From Editor',
          category: 'Hello',
          runsTool: 'echo',
          scope: 'project',
        }),
      ],
      statusBarItems: [
        contributeStatusBarItem({
          id: 'hello-status',
          label: 'Hello',
          tooltip: 'Hello plugin project module',
          alignment: 'right',
          runsTool: 'echo',
          scope: 'project',
        }),
      ],
      runConfigurations: [
        contributeRunConfiguration({
          id: 'npm-test',
          title: 'npm test',
          kind: 'node',
          command: 'npm',
          args: ['test'],
          scope: 'project',
        }),
      ],
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

/**
 * Webview entry is a `*.template.html`: `mcp-plugin build` bundles `./src/main.ts`
 * (and any relative <link>) inline into a self-contained `ui/panel.html` (the
 * artifact the tool window's `entry` points at). The `.mcp-*` kit CSS is injected
 * by the host at runtime — never vendor it.
 */
export const PANEL_TEMPLATE_HTML = `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <style>
      html, body { height: 100%; }
    </style>
  </head>
  <body>
    <div id="root" class="mcp-app"></div>
    <script src="./src/main.ts"></script>
  </body>
</html>
`;

export const UI_MAIN_TS = `import { mcp, pageHeader, state } from '@mcp/plugin-sdk/ui';

/**
 * Starter panel. Build your UI with the @mcp/plugin-sdk/ui primitives —
 * masterDetail, navRail, dataTable, status, pageHeader, icon, … — over the
 * host-injected .mcp-* kit. window.mcp talks to the host (invokeTool, ui, …).
 */
const root = document.getElementById('root');
if (root) {
  root.append(
    pageHeader({
      title: 'Hello',
      subtitle: 'A starter plugin panel.',
      primary: { label: 'Echo', icon: 'sparkles', onClick: () => void echo() },
    }),
    state({
      icon: 'sparkles',
      title: 'Welcome',
      message: 'Edit ui/src/main.ts to build your panel.',
    }),
  );
}

async function echo(): Promise<void> {
  const r = await mcp.invokeTool('echo', { text: 'Hello from the panel' });
  void mcp.ui.toast({ kind: 'success', message: r.content });
}
`;

// Generated build artifacts are not committed (the template + src are the source).
export const GITIGNORE = 'dist/\nnode_modules/\n.app.json\nui/panel.html\n';
