/**
 * Host-side project scaffolding — creates a new project on the user's
 * machine under `~/.mcp-code-indexer/projects/<slug>` by running the official stack
 * CLIs (create-vite, create-next-app, create-cloudflare, git clone, …),
 * then hands the resolved path back for registration as a normal project.
 *
 * Containerless sibling of `../sandbox/scaffolders/`. Powers the dashboard
 * "New Project" wizard via `@mcp/api-handlers` projects.scaffold.
 */
export { runHostScaffold } from './scaffold-runner.js';
export type { ScaffoldCallbacks, ScaffoldRunInput, ScaffoldOutcome } from './scaffold-runner.js';
export {
  injectBuilderStampHost,
  repairBuilderStampHost,
  renderHostViteConfig,
  findFreeBuilderPort,
  BUILDER_DEV_DEPS,
  BUILDER_DEPS,
} from './builder-inject.js';
export { runHostCommand } from './run-host-command.js';
export type { RunHostCommandResult } from './run-host-command.js';
export { upsertNpmrcScopedRegistry, removeNpmrcScopedRegistry, packageScope } from './npmrc.js';
export { installDsPackage, uninstallDsPackage } from './ds-consumer-install.js';
export { INSTALL_TIMEOUT_MS, NON_INTERACTIVE_ENV } from './templates/types.js';
export { validateScaffoldInput, ScaffoldValidationError } from './validate.js';
export type { ScaffoldInput } from './validate.js';
export { userProjectsRoot, resolveTargetPath } from './paths.js';
export type { ResolvedTarget } from './paths.js';
export { slugify } from './slugify.js';
export { TEMPLATE_IDS, isTemplateId, getHostTemplate } from './templates/registry.js';
export type { TemplateId, HostTemplate } from './templates/types.js';
export {
  scaffoldDsStudioWorkspace,
  buildReactWorkspaceFiles,
  buildVueWorkspaceFiles,
  renderDsStudioViteConfig,
} from './ds-studio/index.js';
export type {
  DsStudioScaffoldInput,
  DsStudioScaffoldOutcome,
  DsStudioStack,
} from './ds-studio/index.js';
export { scaffoldAppStudioWorkspace } from './app-studio/index.js';
export type { AppStudioScaffoldInput, AppStudioScaffoldOutcome } from './app-studio/index.js';
