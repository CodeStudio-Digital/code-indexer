/**
 * Scanner ignore rules: binary extensions, default patterns, .gitignore /
 * .mcpindexignore loading, and the hard-safe glob prune list. Extracted from
 * scanner.ts so the scan loop stays readable.
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import ignore from 'ignore';
import {
  getProjectIgnoreRules,
  shouldIgnoreProjectPath,
  type ProjectIgnoreRules,
} from '@mcp/shared/utils/project-ignore.js';

import { isBinaryIndexPath } from '@mcp/shared/utils/index-binaries.js';

const DEFAULT_IGNORE_PATTERNS = [
  'node_modules',
  '.git',
  '.mcp-indexer',
  'dist',
  'build',
  '.next',
  '.nuxt',
  'coverage',
  '__pycache__',
  '.cache',
  '.vscode',
  '.idea',
  '*.min.js',
  '*.min.css',
  '*.map',
  'package-lock.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  'bun.lockb',
];

/**
 * Directories the glob walk prunes ENTIRELY (`**\/<dir>/**`). Only the
 * hard-safe set that the default patterns already discard 100% of — the
 * fine-grained rules (.gitignore, user patterns, binaries, mapper) still run
 * in the post-walk filter. Pruning here means the walker never descends into
 * node_modules at all, instead of listing it and filtering afterwards.
 */
export const GLOB_PRUNE_DIRS = [
  'node_modules', '.git', '.mcp-indexer', 'dist', 'build', '.next', '.nuxt',
  'coverage', '__pycache__', '.cache',
];

export interface ScannerIgnore {
  ignoresDirectory(relPath: string): boolean;
  /** True when the relative path must be skipped (binary, ignored, hard-excluded). */
  ignores(relPath: string): boolean;
}


/**
 * Build the composite ignore filter for a project root: defaults + caller
 * patterns + .gitignore + .mcpindexignore (project-specific rules).
 */
export function buildScannerIgnore(
  rootPath: string,
  extraPatterns: string[],
  isHardExcluded: (relPath: string) => boolean,
  projectRules: ProjectIgnoreRules = getProjectIgnoreRules(rootPath),
): ScannerIgnore {
  const ig = ignore();
  ig.add(DEFAULT_IGNORE_PATTERNS);
  ig.add(extraPatterns);

  const gitignorePath = join(rootPath, '.gitignore');
  if (existsSync(gitignorePath)) {
    ig.add(readFileSync(gitignorePath, 'utf-8'));
  }

  const mcpIgnorePath = join(rootPath, '.mcpindexignore');
  if (existsSync(mcpIgnorePath)) {
    ig.add(readFileSync(mcpIgnorePath, 'utf-8'));
  }

  return {
    ignoresDirectory(relPath: string): boolean {
      return shouldIgnoreProjectPath(projectRules, relPath, true) || ig.ignores(relPath + '/');
    },
    ignores(relPath: string): boolean {
      if (isBinaryIndexPath(relPath)) return true;
      if (shouldIgnoreProjectPath(projectRules, relPath)) return true;
      if (ig.ignores(relPath)) return true;
      if (isHardExcluded(relPath)) return true;
      return false;
    },
  };
}
