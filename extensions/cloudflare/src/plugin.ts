/**
 * Cloudflare manager plugin — vertical slice. Declares the capabilities it
 * needs (granted at install): fs to detect/read the wrangler config + package
 * manifest, exec to run `npx wrangler`, storage to hold the API token + chosen
 * account. The management UI (right-rail webview) drives the tools through
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
      icon: 'cloud',
      side: 'right',
      entry: 'ui/panel.html',
      // No activation rule (Podman model): D1/KV/R2/DNS/… are ACCOUNT-level
      // resources, useful from any project. Project-bound actions (deploy/
      // build/preview) surface contextually inside the panel via cf_detect.
    }),
  ],
});
