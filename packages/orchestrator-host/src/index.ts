/**
 * @mcp/orchestrator-host — foundation for running CompanyOrchestrator
 * instances inside `worker_threads`.
 *
 * Public surface (this file re-exports everything callers need):
 *   - Protocol envelope types (Request / Response / Event)
 *   - `MessageBridge` — typed req/res/evt over a MessagePort
 *   - `WorkerHost` — supervisor for one Worker (start, evict, restart)
 *   - `DbConnection` / `openWorkerDb` — per-worker SQLite handle
 *
 * Phase 12 ships the foundation only; the actual CompanyOrchestrator
 * migration happens in Phase 13 with one endpoint per PR (see
 * `MIGRATION.md`).
 *
 * Architecture (target state):
 *
 *   ┌─ Main thread (HTTP / SSE / WS gateway) ─────────────────────┐
 *   │  OrchestratorPool — Map<companySessionId, WorkerHost>       │
 *   │   ↓ request(...)                            ↑ events (evt) │
 *   │  MessageBridge (per session)                                │
 *   └─────────────────────────────────────────────────────────────┘
 *                                ⇅ MessagePort (structuredClone)
 *   ┌─ Worker thread (one per active session) ────────────────────┐
 *   │  worker-entry.ts → opens DbConnection → instantiates        │
 *   │  CompanyOrchestrator → MessageBridge → publishes meta-bus   │
 *   │  events as `evt` envelopes back to main.                    │
 *   └─────────────────────────────────────────────────────────────┘
 */

export * from './protocol.js';
export {
  MessageBridge,
  ErrPortClosed,
  ErrRequestTimeout,
  isPortClosedError,
} from './MessageBridge.js';
export type { MessageBridgeOpts, MessagePortLike } from './MessageBridge.js';
export { WorkerHost } from './WorkerHost.js';
export type { WorkerHostOpts, WorkerHostStatus } from './WorkerHost.js';
export { DbConnection, openWorkerDb } from './DbConnection.js';
export type { DbConnectionOpts } from './DbConnection.js';
