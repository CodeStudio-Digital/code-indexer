/**
 * Source-stamp registry — maps a `SandboxStack` to its `SourceStampPlugin`.
 *
 * Returns `null` for stacks without stamping support yet (Vue lands in a
 * later phase). Both the BuilderScaffolder (writes the files + config) and
 * the provision path (persists `sb.viteStamp` for restart survival) resolve
 * through this single function, so they can never diverge.
 */
import type { SandboxStack } from '../../types.js';
import type { SourceStampPlugin } from './types.js';
import { ReactSourceStamp } from './react-stamp.js';

const react = new ReactSourceStamp();

export function getSourceStampPlugin(stack: SandboxStack): SourceStampPlugin | null {
  switch (stack) {
    case 'react-ts':
      return react;
    // 'vue-ts' → VueSourceStamp (later phase)
    default:
      return null;
  }
}
