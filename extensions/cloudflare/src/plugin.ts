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
      read: [
        'wrangler.toml',
        'wrangler.jsonc',
        'wrangler.json',
        'package.json',
        // OpenNext config — read to classify the deploy model.
        'open-next.config.ts',
        'open-next.config.js',
        'open-next.config.mjs',
      ],
      write: ['wrangler.toml', 'wrangler.jsonc', 'wrangler.json'],
    },
    // `opennextjs-cloudflare` (+ alias `open-next`) so OpenNext build/deploy/
    // preview pass the exec allowlist; without these the host denies them.
    exec: { allow: ['npx', 'wrangler', 'opennextjs-cloudflare', 'open-next'] },
    storage: true,
  },
  tools: allTools,
  toolWindows: [
    contributeToolWindow({
      id: 'cf-manage',
      title: 'Cloudflare',
      side: 'bottom',
      entry: 'ui/panel.html',
      // Auto-detect: surface this panel in any Cloudflare project — a wrangler
      // config or OpenNext config at the root, or a CF/OpenNext dep.
      activation: {
        whenFiles: [
          'wrangler.toml',
          'wrangler.jsonc',
          'wrangler.json',
          'open-next.config.ts',
          'open-next.config.js',
          'open-next.config.mjs',
        ],
        whenPackageDep: ['wrangler', '@cloudflare/workers-types', '@opennextjs/cloudflare'],
      },
    }),
  ],
});
