/**
 * DS Studio workspace scaffold — galeria viva (`app/`) + lib publicável
 * (`pkg/`) num npm workspace de host project. Ver scaffold-ds-studio.ts.
 */
export { scaffoldDsStudioWorkspace } from './scaffold-ds-studio.js';
export type { DsStudioScaffoldInput, DsStudioScaffoldOutcome } from './scaffold-ds-studio.js';
export type { DsStudioStack, WorkspaceFile, DsTemplateInput } from './types.js';
export { buildReactWorkspaceFiles, renderDsStudioViteConfig } from './react-inject.js';
export { buildVueWorkspaceFiles } from './templates-vue.js';
export { angularCliSteps, patchAngularWorkspace } from './templates-angular.js';
