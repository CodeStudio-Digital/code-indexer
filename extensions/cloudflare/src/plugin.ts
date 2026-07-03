/**
 * Cloudflare manager plugin — vertical slice. Declares the capabilities it
 * needs (granted at install): fs to detect/read the wrangler config + package
 * manifest, exec to run `npx wrangler`, storage to hold the API token + chosen
 * account. The management UI (right-rail webview) drives the tools through
 * window.mcp.invokeTool.
 */
import {
  definePlugin,
  contributeToolWindow,
  contributeProjectModule,
  contributeEditorAction,
  contributeStatusBarItem,
  contributeRunConfiguration,
} from '@mcp/plugin-sdk/define.js';
import { allTools } from './all-tools.js';

const cloudflareProject = {
  whenFiles: [
    'wrangler.toml',
    'wrangler.jsonc',
    'wrangler.json',
    'open-next.config.ts',
    'open-next.config.js',
    'open-next.config.mjs',
  ],
  whenPackageDep: ['wrangler', '@cloudflare/workers-types', '@opennextjs/cloudflare'],
};

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
  modules: [
    contributeProjectModule({
      id: 'cloudflare-worker',
      title: 'Cloudflare Worker',
      description: 'Wrangler/OpenNext project module with deploy, build and preview actions.',
      icon: 'cloud',
      activation: cloudflareProject,
      tools: ['cf_detect', 'cf_deploy', 'cf_build', 'cf_preview'],
      editorActions: [
        contributeEditorAction({
          id: 'cf-detect-project',
          label: 'Cloudflare: Detect Project',
          category: 'Cloudflare',
          runsTool: 'cf_detect',
          scope: 'project',
        }),
        contributeEditorAction({
          id: 'cf-deploy-project',
          label: 'Cloudflare: Deploy Project',
          category: 'Cloudflare',
          runsTool: 'cf_deploy',
          scope: 'project',
        }),
      ],
      statusBarItems: [
        contributeStatusBarItem({
          id: 'cf-project',
          label: 'Cloudflare',
          tooltip: 'Cloudflare project detected',
          alignment: 'right',
          priority: 40,
          runsTool: 'cf_detect',
          scope: 'project',
        }),
      ],
      runConfigurations: [
        contributeRunConfiguration({
          id: 'cf-deploy',
          title: 'Cloudflare Deploy',
          kind: 'cloudflare',
          command: 'npx',
          args: ['wrangler', 'deploy'],
          scope: 'project',
        }),
        contributeRunConfiguration({
          id: 'cf-dev',
          title: 'Cloudflare Dev',
          kind: 'cloudflare',
          command: 'npx',
          args: ['wrangler', 'dev'],
          scope: 'project',
        }),
      ],
    }),
  ],
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
