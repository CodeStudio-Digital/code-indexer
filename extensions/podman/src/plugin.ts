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
import {
  definePlugin,
  contributeToolWindow,
  contributeProjectModule,
  contributeEditorAction,
  contributeStatusBarItem,
  contributeRunConfiguration,
} from '@mcp/plugin-sdk/define.js';
import { allTools } from './all-tools.js';

const containerProject = {
  whenFiles: [
    'Containerfile',
    'Dockerfile',
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
};

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
  modules: [
    contributeProjectModule({
      id: 'containerized-project',
      title: 'Containerized Project',
      description: 'Podman project module with detect, containerize, build/run and compose actions.',
      icon: 'container',
      activation: containerProject,
      tools: ['podman_detect', 'podman_containerize', 'podman_project_run', 'podman_compose'],
      editorActions: [
        contributeEditorAction({
          id: 'podman-detect-project',
          label: 'Podman: Detect Project',
          category: 'Podman',
          runsTool: 'podman_detect',
          scope: 'project',
        }),
        contributeEditorAction({
          id: 'podman-containerize-project',
          label: 'Podman: Generate Containerfile',
          category: 'Podman',
          runsTool: 'podman_containerize',
          scope: 'project',
        }),
        contributeEditorAction({
          id: 'podman-run-project',
          label: 'Podman: Build and Run Project',
          category: 'Podman',
          runsTool: 'podman_project_run',
          scope: 'project',
        }),
      ],
      statusBarItems: [
        contributeStatusBarItem({
          id: 'podman-project',
          label: 'Podman',
          tooltip: 'Container project tools available',
          alignment: 'right',
          priority: 30,
          runsTool: 'podman_detect',
          scope: 'project',
        }),
      ],
      runConfigurations: [
        contributeRunConfiguration({
          id: 'podman-build-run',
          title: 'Podman Build and Run',
          kind: 'podman',
          command: 'podman',
          args: ['build', '-t', 'project:dev', '.'],
          scope: 'project',
        }),
        contributeRunConfiguration({
          id: 'podman-compose-up',
          title: 'Podman Compose Up',
          kind: 'podman',
          command: 'podman',
          args: ['compose', 'up', '-d'],
          scope: 'project',
        }),
      ],
    }),
  ],
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
