/**
 * MetaBusPublisher — thin adapter over the functional coder-bus API so
 * services depend on a small injected port instead of free functions.
 *
 * Responsibilities:
 *   - `publish(event, data)` — buffered + fanned out to subscribers
 *   - `markEnded(event, data)` — terminates the bus for reattach clients
 *
 * Services call this instead of importing `publish`/`markEnded` from the
 * bus module directly — which keeps the test surface small (inject a
 * fake port) and the coupling one-way.
 */

import type { CoderRunBus } from '@apps/http-api/coder-bus.js';
import { publish as busPublish, markEnded as busMarkEnded } from '@apps/http-api/coder-bus.js';
import type { IMetaBusPublisher } from '@mcp/company/services/ports.js';

export class MetaBusPublisher implements IMetaBusPublisher {
  /**
   * Optional callback fired before each publish. Used by `IdleWatchdog`
   * to reset its "last activity" timestamp without forcing the
   * watchdog to subscribe to every event type explicitly. Set via
   * `setActivityListener` after construction so wiring order
   * (publisher first, watchdog later) stays clean.
   */
  private activityListener: (() => void) | null = null;

  constructor(readonly bus: CoderRunBus) {}

  setActivityListener(listener: (() => void) | null): void {
    this.activityListener = listener;
  }

  publish(event: string, data: unknown): void {
    if (this.activityListener) {
      try { this.activityListener(); } catch { /* best-effort */ }
    }
    busPublish(this.bus, event, data);
  }

  markEnded(event: 'done' | 'error', data: unknown): void {
    busMarkEnded(this.bus, event, data);
  }
}
