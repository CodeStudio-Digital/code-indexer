/**
 * Scaffolder registry — maps a `SandboxStack` to an `IScaffolder` instance.
 *
 * Adding a stack = one registration here. Existing code is untouched,
 * satisfying OCP.
 *
 * **Per-session opts**: scaffolders that depend on session-level flags
 * (e.g. `includeE2e` for the QA Playwright bootstrap) are constructed
 * lazily in `getScaffolder(stack, opts)` rather than cached as
 * singletons. Caching one instance per opts combo would be a
 * micro-optimisation; rebuilding is cheap (no I/O, just `new`).
 */

import type { SandboxStack } from '../types.js';
import type { IScaffolder } from './scaffolder-port.js';
import { ReactTsScaffolder } from './react-ts-scaffolder.js';
import { VueTsScaffolder } from './vue-ts-scaffolder.js';
import { ViteApiScaffolder } from './vite-api-scaffolder.js';
import { CfWorkerScaffolder } from './cf-worker-scaffolder.js';
import { AngularScaffolder } from './angular-scaffolder.js';
import { NodeOnlyScaffolder } from './node-only-scaffolder.js';

export interface GetScaffolderOptions {
  /**
   * Override for the QA Playwright bootstrap. When undefined, falls back
   * to the legacy global env var `MCP_SANDBOX_INCLUDE_E2E=1` so dev
   * sessions started before the per-session UI shipped still work.
   */
  includeE2e?: boolean;
}

/** Test / plugin hook: register a scaffolder for a new stack at runtime. */
const overrides = new Map<SandboxStack, IScaffolder>();
export function registerScaffolder(scaffolder: IScaffolder): void {
  overrides.set(scaffolder.stack, scaffolder);
}

/** Pure: resolve the effective `includeE2e` from explicit opts + env fallback. */
export function resolveIncludeE2e(opts?: GetScaffolderOptions, env: NodeJS.ProcessEnv = process.env): boolean {
  if (typeof opts?.includeE2e === 'boolean') return opts.includeE2e;
  return env.MCP_SANDBOX_INCLUDE_E2E === '1';
}

export function getScaffolder(
  stack: SandboxStack,
  opts: GetScaffolderOptions = {},
): IScaffolder {
  if (stack === 'local-process') {
    // Defensive: `local-process` is host-side and must never reach the
    // container-provisioning path. If it does, someone wired a
    // local-project flow into the sandbox manager by mistake.
    throw new Error(
      "stack='local-process' has no scaffolder — use LocalProcessManager instead",
    );
  }
  const override = overrides.get(stack);
  if (override) return override;

  const includeE2e = resolveIncludeE2e(opts);
  switch (stack) {
    case 'react-ts':
      return new ReactTsScaffolder({ includeE2e });
    case 'vue-ts':
      return new VueTsScaffolder();
    case 'angular':
      return new AngularScaffolder();
    case 'vite-api':
      return new ViteApiScaffolder();
    case 'cf-worker':
      return new CfWorkerScaffolder();
    case 'node-only':
      return new NodeOnlyScaffolder();
    default: {
      // Exhaustive check — TS will yell if a new SandboxStack lands without
      // a switch arm; unknown values at runtime fall through here.
      throw new Error(`No scaffolder registered for stack '${stack}'`);
    }
  }
}
