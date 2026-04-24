/**
 * Scaffolder registry — maps a `SandboxStack` to an `IScaffolder` instance.
 *
 * Adding a stack = one registration here. Existing code is untouched,
 * satisfying OCP.
 */

import type { SandboxStack } from '../types.js';
import type { IScaffolder } from './scaffolder-port.js';
import { ReactTsScaffolder } from './react-ts-scaffolder.js';
import { VueTsScaffolder } from './vue-ts-scaffolder.js';
import { ViteApiScaffolder } from './vite-api-scaffolder.js';
import { CfWorkerScaffolder } from './cf-worker-scaffolder.js';
import { AngularScaffolder } from './angular-scaffolder.js';

const scaffolders = new Map<SandboxStack, IScaffolder>([
  ['react-ts', new ReactTsScaffolder()],
  ['vue-ts', new VueTsScaffolder()],
  ['angular', new AngularScaffolder()],
  ['vite-api', new ViteApiScaffolder()],
  ['cf-worker', new CfWorkerScaffolder()],
]);

export function getScaffolder(stack: SandboxStack): IScaffolder {
  if (stack === 'local-process') {
    // Defensive: `local-process` is host-side and must never reach the
    // container-provisioning path. If it does, someone wired a
    // local-project flow into the sandbox manager by mistake.
    throw new Error(
      "stack='local-process' has no scaffolder — use LocalProcessManager instead",
    );
  }
  const s = scaffolders.get(stack);
  if (!s) throw new Error(`No scaffolder registered for stack '${stack}'`);
  return s;
}

/** Test / plugin hook: register a scaffolder for a new stack at runtime. */
export function registerScaffolder(scaffolder: IScaffolder): void {
  scaffolders.set(scaffolder.stack, scaffolder);
}
