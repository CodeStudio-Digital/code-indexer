/**
 * React + Vite + TypeScript scaffolder.
 *
 * Trivial subclass — all the machinery lives in `ViteScaffolderBase`.
 * Exists as a class (not a function) so we can register an instance in
 * a stack→scaffolder map and keep the surface symmetrical with non-Vite
 * scaffolders that will need their own base (PHP, Django, etc).
 */

import { ViteScaffolderBase } from './vite-scaffolder-base.js';

export interface ReactTsScaffolderOptions {
  /**
   * When true, the scaffolder additionally installs `@playwright/cli`,
   * `@playwright/test`, and the chromium browser inside the sandbox so
   * QA agents can drive the preview out-of-the-box. Off by default.
   */
  includeE2e?: boolean;
}

export class ReactTsScaffolder extends ViteScaffolderBase {
  constructor(options: ReactTsScaffolderOptions = {}) {
    super({
      stack: 'react-ts',
      viteTemplate: 'react-ts',
      includeE2e: options.includeE2e ?? false,
    });
  }
}
