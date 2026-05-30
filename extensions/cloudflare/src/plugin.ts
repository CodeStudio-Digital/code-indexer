/**
 * Cloudflare manager plugin — vertical slice. Declares the capabilities it
 * needs (granted at install): fs to detect/read the wrangler config + package
 * manifest, exec to run `npx wrangler`, storage to hold the API token + chosen
 * account. The management UI (bottom panel webview) drives the tools through
 * window.mcp.invokeTool.
 */
import { definePlugin, contributeToolWindow } from '@mcp/plugin-sdk/define.js';
import { allTools } from './all-tools.js';

export default definePlugin({
  permissions: {
    fs: {
      read: ['wrangler.toml', 'wrangler.jsonc', 'wrangler.json', 'package.json'],
      write: ['wrangler.toml', 'wrangler.jsonc', 'wrangler.json'],
    },
    exec: { allow: ['npx', 'wrangler'] },
    storage: true,
  },
  tools: allTools,
  toolWindows: [
    contributeToolWindow({
      id: 'cf-manage',
      title: 'Cloudflare',
      side: 'bottom',
      entry: 'ui/panel.html',
    }),
  ],
});
