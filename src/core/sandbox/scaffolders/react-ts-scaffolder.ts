/**
 * React + Vite + TypeScript scaffolder.
 *
 * Trivial subclass — all the machinery lives in `ViteScaffolderBase`.
 * Exists as a class (not a function) so we can register an instance in
 * a stack→scaffolder map and keep the surface symmetrical with non-Vite
 * scaffolders that will need their own base (PHP, Django, etc).
 */

import { ViteScaffolderBase } from './vite-scaffolder-base.js';

export class ReactTsScaffolder extends ViteScaffolderBase {
  constructor() {
    super({ stack: 'react-ts', viteTemplate: 'react-ts' });
  }
}
