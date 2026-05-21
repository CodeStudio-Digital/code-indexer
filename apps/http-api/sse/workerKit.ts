/**
 * Worker-side imports re-exported via a path the workers can resolve
 * without the tsconfig `paths` alias.
 *
 * Workers spawn with `--import tsx/esm` (dev) or as built `.js` (prod).
 * In dev, tsx transforms TypeScript but does NOT extend the project's
 * tsconfig `paths` map into worker threads — Node's resolver runs first
 * and fails on `@mcp/*` imports with "Cannot find package". Relative
 * imports work fine in both modes, so this barrel funnels every worker
 * dependency through one local path that resolves identically under
 * tsx, tsc, and node.
 */
export {
  MessageBridge,
  openWorkerDb,
  ErrPortClosed,
  ErrRequestTimeout,
} from '../../../packages/orchestrator-host/src/index.js';
export type {
  MessageBridgeOpts,
  MessagePortLike,
  WorkerHostOpts,
} from '../../../packages/orchestrator-host/src/index.js';
