/** Shared shapes for the DS Studio workspace scaffold. */

export type DsStudioStack = 'react-ts' | 'vue-ts' | 'angular';

export interface WorkspaceFile {
  /** Path relative to the workspace root (POSIX separators). */
  path: string;
  contents: string;
}

export interface DsTemplateInput {
  /** Workspace folder slug (root package.json name). */
  slug: string;
  /** npm package name of the library (`pkg/package.json#name`). */
  packageName: string;
}
