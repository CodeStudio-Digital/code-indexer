import type { ContributedDebugger } from './types.js';

/** Declare language/project metadata for a host-owned debugger surface. */
export function contributeDebugger(def: ContributedDebugger): ContributedDebugger {
  return def;
}
