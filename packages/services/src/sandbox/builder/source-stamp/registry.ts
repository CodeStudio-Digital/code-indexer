/**
 * Source-stamp registry — maps a `SandboxStack` to its `SourceStampPlugin`.
 *
 * Returns `null` for stacks without stamping support yet (Vue lands in a
 * later phase). Host-scaffold consumers resolve through this function.
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
