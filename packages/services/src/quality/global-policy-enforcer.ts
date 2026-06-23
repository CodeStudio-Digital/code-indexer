/**
 * Global PolicyEnforcer holder.
 *
 * Same singleton-holder pattern as `global-classifier-runner.ts` —
 * lets the boot path install one enforcer and the runner pick it up
 * without taking a constructor dependency on `@mcp/services/quality`.
 *
 * Off when nothing is installed (returns undefined). Runner short-circuits
 * the entire policy hook in that case — zero overhead.
 */
import type { PolicyEnforcer } from './policy-enforcer.js';

let globalEnforcer: PolicyEnforcer | undefined;

export function setGlobalPolicyEnforcer(enforcer: PolicyEnforcer | undefined): void {
  globalEnforcer = enforcer;
}

export function getGlobalPolicyEnforcer(): PolicyEnforcer | undefined {
  return globalEnforcer;
}
