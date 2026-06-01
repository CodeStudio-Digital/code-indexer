/**
 * Podman manager plugin — vertical slice mirroring the Cloudflare plugin.
 * Declares the capabilities it needs (granted at install): `exec` to run the
 * `podman` CLI, `fs` (read) to detect Dockerfile/Containerfile/compose in the
 * project, and `storage` for small preferences. The bottom-panel webview drives
 * the tools through window.mcp.invokeTool.
 *
 * The tool window has NO activation rule, so the panel is ALWAYS available —
 * Podman is a project-agnostic capability (you may run any image regardless of
 * what files the project ships).
 */
import { definePlugin, contributeToolWindow } from '@mcp/plugin-sdk/define.js';
import { allTools } from './all-tools.js';

export default definePlugin({
  permissions: {
    fs: {
      // Read: container files + stack-detection markers (for podman_containerize).
      read: [
        'Dockerfile',
        'Containerfile',
        'compose.yaml',
        'compose.yml',
        'docker-compose.yml',
        'docker-compose.yaml',
        'package.json',
        'requirements.txt',
        'pyproject.toml',
        'go.mod',
        'index.html',
      ],
      // Write: only the artifacts the containerize tool generates.
      write: ['Dockerfile', 'Containerfile', '.dockerignore'],
    },
    exec: { allow: ['podman'] },
    storage: true,
  },
  tools: allTools,
  toolWindows: [
    contributeToolWindow({
      id: 'podman-manage',
      title: 'Podman',
      side: 'bottom',
      entry: 'ui/panel.html',
      // No activation: always surface the panel.
    }),
  ],
});
