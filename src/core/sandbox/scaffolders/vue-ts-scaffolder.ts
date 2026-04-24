/**
 * Vue 3 + Vite + TypeScript scaffolder.
 *
 * Same base as React — Vite handles both templates uniformly.
 */

import { ViteScaffolderBase } from './vite-scaffolder-base.js';

export class VueTsScaffolder extends ViteScaffolderBase {
  constructor() {
    super({ stack: 'vue-ts', viteTemplate: 'vue-ts' });
  }
}
