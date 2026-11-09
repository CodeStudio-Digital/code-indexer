import type { ToolRegistry } from './registry.js';
import { deriveCapabilityDescriptor } from './capability-catalog.js';

const snapshots = new WeakMap<ToolRegistry, ReturnType<typeof build>>();
function build(registry: ToolRegistry) {
  return registry.list().map(tool => ({ tool, descriptor: deriveCapabilityDescriptor(tool).descriptor }));
}
/** Canonical attempt catalog. Mutable setup is observed; sealed membership is
 * captured once and shared by every discovery adapter. Never performs I/O. */
export function capabilityDiscoveryEntries(registry: ToolRegistry) {
  if (!registry.isSealed) return build(registry);
  let entries = snapshots.get(registry);
  if (!entries) { entries = build(registry); snapshots.set(registry, entries); }
  return entries;
}
