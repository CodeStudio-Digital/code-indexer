/**
 * Module-level bindings for stores used by Design System tools.
 *
 * Wired once at boot from `server.ts` (mirrors the QA pattern where
 * `setQaTestRunStore` injects the singleton). Tools import the getters
 * to access stores; returning `null` lets each tool render a clear error
 * instead of crashing when the binding is forgotten.
 */
import type { DesignSystemStore } from '@mcp/store/design-system-store.js';
import type { SkillStore } from '@mcp/store/skill-store.js';

let store: DesignSystemStore | null = null;
let skillStore: SkillStore | null = null;

export function setDesignSystemStore(s: DesignSystemStore | null): void {
  store = s;
}

export function getDesignSystemStore(): DesignSystemStore | null {
  return store;
}

export function setSkillStore(s: SkillStore | null): void {
  skillStore = s;
}

export function getSkillStore(): SkillStore | null {
  return skillStore;
}
