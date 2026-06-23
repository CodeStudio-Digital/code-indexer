/**
 * Lightweight frontend-framework detection for a project root, read from
 * package.json deps. Used to auto-pick the preview element-selector mode
 * ("react" native detection vs the generic "universal" CSS picker) — see the
 * `framework` field on the project DTO and `useSelectorMode` in the dashboard.
 *
 * NOT persisted: derived at read time in the `get` handler so it tracks
 * dependency changes with no migration. Separate concern from
 * `runner/detect.ts` (which enumerates runnable scripts). Pure node:fs,
 * fail-open to null.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export type ProjectFramework = 'next' | 'react' | 'vue' | 'angular';

function readDeps(root: string): Record<string, string> {
  try {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    return { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
  } catch {
    return {};
  }
}

/**
 * Classify a project's frontend framework from package.json. Precedence is
 * next → react → vue → angular: Next implies React, but the picker wants the
 * most specific label. Returns null when no known framework (or no
 * package.json) is present.
 */
export function detectProjectFramework(root: string): ProjectFramework | null {
  if (!root || !existsSync(join(root, 'package.json'))) return null;
  const deps = readDeps(root);
  if (deps['next']) return 'next';
  if (deps['react'] || deps['react-dom']) return 'react';
  if (deps['vue']) return 'vue';
  if (deps['@angular/core']) return 'angular';
  return null;
}
